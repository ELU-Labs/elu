import { ink, wrapText } from './terminal-visuals.mjs';
import { columns, cut, padEnd, padStart } from './width.mjs';
import { KINDS, everyText } from './artifacts.mjs';
import { clockTime } from './terminal-plan.mjs';

// How a session's artifacts (lib/artifacts.mjs) read on its Artifacts tab: text only, in the
// app's own colours, so they read the same over SSH and inside tmux. ELU draws each kind from
// the data the model or its refresh script gave; nothing the model sends is drawn as it sent it.
// Every label and cell is the model's text, so each goes through ink() as untrusted text.
// A note is plain text here; the Markdown renderer draws it where the app has one (noteRows).

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
// A number as people read it: at most one decimal, none for a whole number; % sticks to it, any
// other unit follows with a space.
export function numberText(value, unit = '') {
  const text = Number.isInteger(value) ? String(value) : Math.abs(value) >= 100 ? String(Math.round(value)) : value.toFixed(Math.abs(value) < 1 ? 2 : 1).replace(/\.?0+$/, '');
  return unit ? unit === '%' ? `${text}%` : `${text} ${unit}` : text;
}
// Whether a value reaches its target: higher is better unless better says lower. null without a target.
const reaches = (value, target, better) => target === undefined || target === null ? null : better === 'lower' ? value <= target : value >= target;
const tone = (value, target, better) => { const met = reaches(value, target, better); return met === null ? 'text' : met ? 'green' : 'orange'; };
// The change since the update before, as ▲ 2.4 or ▼ 1.1, green when it went the better way.
function change(now, before, unit, better) {
  if (typeof before !== 'number' || typeof now !== 'number') return null;
  const by = now - before; if (Math.abs(by) < 1e-9) return { text: '=', tone: 'muted' };
  const up = by > 0, good = better === 'lower' ? !up : up;
  return { text: `${up ? '▲' : '▼'} ${numberText(Math.abs(by))}`, tone: good ? 'green' : 'orange' };
}
const targetText = (target, unit, better) => target === undefined || target === null ? '' : `target ${better === 'lower' ? '≤' : '≥'} ${numberText(target, unit)}`;
// The block of the same kind and label in an earlier update, for its change and its trend.
const sameBlock = (data, block) => (data?.blocks ?? []).find(other => other.kind === block.kind && (other.label ?? '') === (block.label ?? '')) ?? null;
const rowValue = (block, label) => block?.rows?.find(row => row.label === label)?.value;
// A sparkline of values, the oldest first, as wide as it has values (at most width).
export function sparkline(values, width = 24) {
  const shown = values.filter(value => typeof value === 'number').slice(-Math.max(1, width));
  if (!shown.length) return '';
  const low = Math.min(...shown), high = Math.max(...shown);
  return shown.map(value => high === low ? SPARK[3] : SPARK[Math.round((value - low) / (high - low) * (SPARK.length - 1))]).join('');
}

// A chart (a history given at once): a line for each series over its x labels, drawn in braille
// dots, each point a mark of its series' own, so the series differ without colour too; the target
// as a dashed line; the axis with its values on the left, the x labels under it, as many as fit,
// and a legend with each series' newest value and its change since its first. A null is a gap.
const MARKS = ['●', '■', '◆', '▲', '○', '□', '◇', '△'];
const HUES = ['blue', 'green', 'violet', 'gold', 'pink', 'aqua', 'lime', 'rose', 'orange'];
// The dot of a braille cell at its row (0 to 3) and column (0 or 1).
const DOTS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
// A round step for about count parts between low and high: 1, 2, 2.5 or 5 times a power of ten.
function niceStep(low, high, count) {
  const rough = (high - low) / count, power = 10 ** Math.floor(Math.log10(rough)), scaled = rough / power;
  return power * (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10);
}
function chartRows(block, { width, colour }) {
  const lines = [], unit = block.unit ?? '', points = block.x.length;
  const values = block.series.flatMap(row => row.values).filter(value => typeof value === 'number'), aim = typeof block.target === 'number' ? [block.target] : [];
  const seen = [...values, ...aim];
  // Its axis: what the block says; else 0 to 100 for a percent that stays inside them; else round
  // values around what it shows.
  let low = block.min ?? (unit === '%' && seen.every(value => value >= 0) ? 0 : seen.length ? Math.min(...seen) : 0);
  let high = block.max ?? (unit === '%' && seen.every(value => value <= 100) ? 100 : seen.length ? Math.max(...seen) : 1);
  if (high <= low) { const room = Math.abs(low) / 10 || 1; low -= block.min === undefined ? room : 0; high += block.max === undefined || high <= low ? room : 0; }
  const step = niceStep(low, high, 4);
  if (block.min === undefined) low = Math.floor(low / step + 1e-9) * step;
  if (block.max === undefined) high = Math.ceil(high / step - 1e-9) * step;
  const ticks = []; for (let at = Math.ceil(low / step - 1e-9) * step; at <= high + step * 1e-9; at += step) ticks.push(Number(at.toPrecision(12)));
  const tall = width >= 100 ? 13 : 9, dots = tall * 4;
  const rowOf = value => Math.max(0, Math.min(dots - 1, Math.round((high - value) / (high - low) * (dots - 1))));
  const labels = new Map(); for (const tick of ticks) { const row = Math.floor(rowOf(tick) / 4); if (!labels.has(row)) labels.set(row, numberText(tick, unit)); }
  const side = Math.max(...[...labels.values()].map(text => columns(text))), wide = Math.max(4, width - side - 2), across = wide * 2;
  const colOf = index => points === 1 ? Math.floor(across / 2) : Math.round(index * (across - 1) / (points - 1));
  // Each cell: its braille dots and the series that drew them last, a point's mark, the target's dash.
  const cells = Array.from({ length: tall }, () => Array.from({ length: wide }, () => ({ bits: 0, hue: null, mark: null })));
  const dot = (x, y, hue) => { const cell = cells[Math.floor(y / 4)]?.[Math.floor(x / 2)]; if (cell) { cell.bits |= DOTS[y % 4][x % 2]; cell.hue = hue; } };
  const dash = aim.length ? Math.floor(rowOf(block.target) / 4) : -1;
  block.series.forEach((row, index) => {
    const hue = HUES[index % HUES.length];
    for (let at = 0; at + 1 < points; at++) {
      const from = row.values[at], to = row.values[at + 1];
      if (typeof from !== 'number' || typeof to !== 'number') continue;
      // The line between two points, a dot in each column it crosses and each row it climbs.
      let x0 = colOf(at), y0 = rowOf(from); const x1 = colOf(at + 1), y1 = rowOf(to), dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      for (let error = dx + dy; ; ) { dot(x0, y0, hue); if (x0 === x1 && y0 === y1) break; const twice = 2 * error; if (twice >= dy) { error += dy; x0 += sx; } if (twice <= dx) { error += dx; y0 += sy; } }
    }
  });
  block.series.forEach((row, index) => row.values.forEach((value, at) => { if (typeof value === 'number') { const cell = cells[Math.floor(rowOf(value) / 4)][Math.floor(colOf(at) / 2)]; cell.mark = MARKS[index % MARKS.length]; cell.hue = HUES[index % HUES.length]; } }));
  // A row of cells as text: runs of one colour inked together.
  const drawn = (row, y) => {
    let text = '', run = '', tone = null;
    const flush = () => { if (run) text += ink(run, tone ?? 'text', colour); run = ''; };
    for (const cell of row) {
      const [shown, shade] = cell.mark ? [cell.mark, cell.hue] : cell.bits ? [String.fromCharCode(0x2800 + cell.bits), cell.hue] : y === dash ? ['╌', 'muted'] : [' ', 'text'];
      if (shade !== tone) { flush(); tone = shade; }
      run += shown;
    }
    flush(); return text;
  };
  if (block.label) lines.push(ink(block.label, 'muted', colour, true));
  cells.forEach((row, y) => lines.push(`${ink(padStart(labels.get(y) ?? '', side), 'muted', colour)} ${ink(labels.has(y) ? '┤' : '│', 'dim', colour)}${drawn(row, y)}`));
  lines.push(`${' '.repeat(side + 1)}${ink(`└${'─'.repeat(wide)}`, 'dim', colour)}`);
  // The x labels, each under its point and inside the chart; one that would touch the one before
  // it is left out, and the last one shows over those before it.
  const spot = index => { const text = cut(block.x[index], wide), size = columns(text), start = Math.max(0, Math.min(wide - size, Math.floor(colOf(index) / 2) - Math.floor(size / 2))); return { text, start, end: start + size, index }; };
  const placed = [];
  for (let index = 0; index < points; index++) { const next = spot(index); if (!placed.length || next.start >= placed.at(-1).end + 2) placed.push(next); }
  if (points > 1 && placed.at(-1).index !== points - 1) { const last = spot(points - 1); while (placed.length && placed.at(-1).end + 2 > last.start) placed.pop(); placed.push(last); }
  let under = '', at = 0; for (const label of placed) { under += ' '.repeat(label.start - at) + label.text; at = label.end; }
  lines.push(`${' '.repeat(side + 2)}${ink(under, 'muted', colour)}`);
  // The legend, as many items on a row as fit.
  const items = block.series.map((row, index) => {
    const kept = row.values.filter(value => typeof value === 'number'), last = kept.at(-1), moved = kept.length > 1 ? change(last, kept[0], unit, block.better) : null, hue = HUES[index % HUES.length];
    const text = `${MARKS[index % MARKS.length]} ${row.label}${last === undefined ? '' : ` ${numberText(last, unit)}`}`;
    return { size: columns(text) + (moved ? columns(moved.text) + 1 : 0), text: `${ink(text, hue, colour)}${moved ? ink(` ${moved.text}`, moved.tone, colour) : ''}` };
  });
  if (aim.length) { const text = `╌ ${targetText(block.target, unit, block.better)}`; items.push({ size: columns(text), text: ink(text, 'muted', colour) }); }
  let row = [], used = 0;
  for (const item of items) { if (row.length && used + 3 + item.size > width) { lines.push(row.join('   ')); row = []; used = 0; } used += (row.length ? 3 : 0) + item.size; row.push(item.text); }
  if (row.length) lines.push(row.join('   '));
  return lines;
}

// A column's name in rows of at most width: broken at its spaces and after its hyphens.
function headRows(head, width) {
  const rows = [];
  for (const piece of head.split(/(?<=-)|\s+/).filter(Boolean)) {
    const last = rows.at(-1), joined = last === undefined ? null : `${last}${last.endsWith('-') ? '' : ' '}${piece}`;
    if (joined !== null && columns(joined) <= width) rows[rows.length - 1] = joined; else rows.push(piece);
  }
  return rows.length ? rows : [''];
}
// The rows of one block. width: the columns the tab has. before: the data of the update before
// the one drawn, or null; history: the data of every update kept, the oldest first.
function blockRows(block, { width, colour, before, history }) {
  // A kind this ELU does not know, from a later one, is left out.
  if (!KINDS.includes(block.kind)) return [];
  if (block.kind === 'chart') return chartRows(block, { width, colour });
  const lines = [], put = (text, tone = 'text', bold = false) => lines.push(ink(text, tone, colour, bold));
  const label = block.label ?? '';
  if (block.kind === 'note') {
    if (label) put(label, 'muted', true);
    for (const row of wrapText(block.text, width)) put(row, 'text');
    return lines;
  }
  if (block.kind === 'score') {
    const was = sameBlock(before, block)?.value, moved = change(block.value, was, block.unit, block.better), aim = targetText(block.target, block.unit, block.better);
    const parts = [[label ? `${label}  ` : '', 'muted', false], [numberText(block.value, block.unit), tone(block.value, block.target, block.better), true], [moved ? `  ${moved.text}` : '', moved?.tone ?? 'muted', false], [aim ? `  ${aim}` : '', 'muted', false]];
    // Too long for one row: the label goes on a row of its own.
    const total = parts.reduce((sum, [text]) => sum + columns(text), 0);
    if (total > width && label) { put(cut(label, width), 'muted'); parts[0][0] = ''; }
    lines.push(parts.filter(([text]) => text).map(([text, shade, bold]) => ink(text, shade, colour, bold)).join(''));
    return lines;
  }
  const aim = targetText(block.target, block.unit, block.better);
  if (label || aim) lines.push([label ? ink(label, 'muted', colour, true) : '', aim ? ink(`${label ? ' · ' : ''}${aim}`, 'muted', colour) : ''].join(''));
  if (block.kind === 'bars') {
    const name = Math.min(Math.max(...block.rows.map(row => columns(row.label))), Math.max(6, Math.floor(width / 4)));
    const values = block.rows.map(row => numberText(row.value, block.unit)), number = Math.max(...values.map(text => columns(text)));
    const was = sameBlock(before, block), moves = block.rows.map(row => change(row.value, rowValue(was, row.label), block.unit, block.better)), move = Math.max(0, ...moves.map(row => row ? columns(row.text) + 2 : 0));
    const top = block.max ?? (block.unit === '%' ? 100 : Math.max(...block.rows.map(row => Math.max(row.value, row.target ?? block.target ?? 0)), 0) || 1);
    const room = Math.max(4, Math.min(40, width - name - number - move - 4));
    block.rows.forEach((row, index) => {
      const aimAt = row.target ?? block.target, filled = Math.max(0, Math.min(room, Math.round(row.value / top * room))), mark = aimAt === undefined ? -1 : Math.max(0, Math.min(room - 1, Math.round(aimAt / top * room) - 1));
      let bar = ink('█'.repeat(filled), tone(row.value, aimAt, block.better), colour);
      for (let at = filled; at < room; at++) bar += at === mark ? ink('│', 'muted', colour) : ink('░', 'dim', colour);
      lines.push(`${ink(padEnd(cut(row.label, name), name), 'text', colour)}  ${bar}  ${ink(padStart(values[index], number), tone(row.value, aimAt, block.better), colour, true)}${moves[index] ? ink(`  ${moves[index].text}`, moves[index].tone, colour) : ''}`);
    });
    return lines;
  }
  if (block.kind === 'trend') {
    // One line for a value, or one for each row: its values over the updates kept, oldest first.
    const series = block.rows ? block.rows.map(row => ({ label: row.label, values: history.map(data => rowValue(sameBlock(data, block), row.label)).filter(value => typeof value === 'number') })) : [{ label: '', values: history.map(data => sameBlock(data, block)?.value).filter(value => typeof value === 'number') }];
    const name = Math.min(Math.max(0, ...series.map(row => columns(row.label))), Math.max(6, Math.floor(width / 4)));
    const values = series.map(row => numberText(row.values.at(-1), block.unit)), number = Math.max(...values.map(text => columns(text)));
    const moves = series.map(row => change(row.values.at(-1), row.values.at(-2), block.unit, block.better)), move = Math.max(0, ...moves.map(row => row ? columns(row.text) + 2 : 0));
    const room = Math.max(4, width - (name ? name + 2 : 0) - number - move - 2);
    series.forEach((row, index) => {
      const last = row.values.at(-1);
      lines.push(`${name ? `${ink(padEnd(cut(row.label, name), name), 'text', colour)}  ` : ''}${ink(padEnd(sparkline(row.values, room), Math.min(room, row.values.length)), tone(last, block.target, block.better), colour)}  ${ink(values[index], tone(last, block.target, block.better), colour, true)}${moves[index] ? ink(`  ${moves[index].text}`, moves[index].tone, colour) : ''}`);
    });
    const count = Math.max(...series.map(row => row.values.length));
    if (count < 2) put('The trend builds as it refreshes.', 'muted');
    return lines;
  }
  // table: each column as wide as its widest cell; numbers to the right, and in green or orange
  // against the column's target. On a narrow tab the names of the columns take two rows, then
  // the gaps narrow, then the first column gives up room; what still does not fit is left out, and said.
  const heads = block.columns.map(column => column.unit && column.unit !== '%' ? `${column.label} (${column.unit})` : column.label);
  const cells = block.rows.map(row => row.map((cell, at) => cell === null ? '–' : typeof cell === 'number' ? numberText(cell, block.columns[at].unit === '%' ? '%' : '') : cell));
  const cellWide = heads.map((_, at) => Math.max(1, ...cells.map(row => columns(row[at]))));
  const pieces = head => head.split(/(?<=-)|\s+/).filter(Boolean);
  let wide = heads.map((head, at) => Math.max(columns(head), cellWide[at])), gap = 2;
  const total = () => wide.reduce((sum, value) => sum + value, 0) + (wide.length - 1) * gap;
  if (total() > width) wide = heads.map((head, at) => Math.max(cellWide[at], ...pieces(head).map(piece => columns(piece))));
  if (total() > width) gap = 1;
  if (total() > width) wide[0] = Math.max(4, wide[0] - (total() - width));
  let shown = wide.length;
  while (shown > 1 && wide.slice(0, shown).reduce((sum, value) => sum + value, 0) + (shown - 1) * gap > width) shown--;
  const numeric = block.columns.map((_, at) => block.rows.some(row => typeof row[at] === 'number'));
  const fit = (text, at) => { const kept = cut(text, wide[at]); return numeric[at] ? padStart(kept, wide[at]) : padEnd(kept, wide[at]); };
  // Each name in as many rows as it needs at its width, at most two.
  const named = heads.slice(0, shown).map((head, at) => { const rows = headRows(head, wide[at]); return rows.length > 2 ? [rows[0], rows.slice(1).join(' ')] : rows; });
  const tall = Math.max(...named.map(rows => rows.length));
  for (let n = 0; n < tall; n++) lines.push(named.map((rows, at) => ink(fit(rows[n - (tall - rows.length)] ?? '', at), 'muted', colour, true)).join(' '.repeat(gap)));
  block.rows.forEach((row, index) => lines.push(row.slice(0, shown).map((cell, at) => ink(fit(cells[index][at], at), typeof cell === 'number' ? tone(cell, block.columns[at].target, block.columns[at].better) : 'text', colour)).join(' '.repeat(gap))));
  if (!block.rows.length) put('No rows.', 'muted');
  if (shown < wide.length) put(`${wide.length - shown === 1 ? 'One more column' : `${wide.length - shown} more columns`} in a wider window.`, 'muted');
  return lines;
}

// The rows of one artifact: its title, how often it refreshes and when it was filled; the line
// of its last refresh that failed; then each block, with a blank row between them.
export function artifactRows(item, { width, colour = true, now = Date.now(), noteRows = null } = {}) {
  const lines = [], last = item.updates.at(-1) ?? null, before = item.updates.at(-2)?.data ?? null, history = item.updates.map(update => update.data);
  const when = last ? `updated ${clockTime(Date.parse(last.at), now)}` : 'no data yet';
  const meta = [item.every ? everyText(item.every) : '', when].filter(Boolean).join(' · ');
  const title = cut(item.title, Math.max(8, width - columns(meta) - 2));
  lines.push(`${ink(title, 'text', colour, true)}${' '.repeat(Math.max(2, width - columns(title) - columns(meta)))}${ink(meta, 'muted', colour)}`);
  if (item.run?.ok === false && item.run.at) lines.push(ink(cut(`Last refresh failed at ${clockTime(Date.parse(item.run.at), now)}: ${item.run.error || 'it did not say why'}`, width), 'orange', colour));
  if (!last) {
    for (const row of wrapText(item.shows, width)) lines.push(ink(row, 'muted', colour));
    for (const row of wrapText(item.every && item.script === null ? 'The session fills it, then refreshes it with a script of its own.' : 'The session fills it as the work goes.', width)) lines.push(ink(row, 'muted', colour));
    return lines;
  }
  last.data.blocks.forEach((block, index) => {
    if (!KINDS.includes(block.kind)) return;
    if (index) lines.push('');
    const drawn = block.kind === 'note' && noteRows ? noteRows(block, { width, colour }) : null;
    lines.push(...(drawn ?? blockRows(block, { width, colour, before, history })));
  });
  return lines;
}
// Every artifact of a session, one after the other, for the tab: what it shows when there are none yet too.
export function artifactsView(items, { width, colour = true, now = Date.now(), noteRows = null, waiting = false } = {}) {
  const lines = [];
  // A Task with no artifact yet: how to add one.
  if (!items.length) return [ink('No artifacts yet', 'text', colour, true), ...wrapText('Say in the chat what to show, or Ctrl+T, New goal, with an Artifact: line.', width).map(row => ink(row, 'muted', colour))];
  if (waiting) lines.push(...wrapText('Its Task waits for your approval: these come with it.', width).map(row => ink(row, 'orange', colour)), '');
  items.forEach((item, index) => { if (index) lines.push('', ink('─'.repeat(Math.max(4, Math.min(width, 40))), 'dim', colour), ''); lines.push(...artifactRows(item, { width, colour, now, noteRows })); });
  return lines;
}
