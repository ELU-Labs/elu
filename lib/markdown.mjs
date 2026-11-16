import { redact } from './publish.mjs';
import { PALETTE } from './terminal-visuals.mjs';
import { columns, unitAt, unitWidth, units } from './width.mjs';

// Markdown in a model's or a bot's text, drawn for the terminal: headings, bold, italics, inline
// code, fenced code, lists, quotes, tables, rules and links. Only the drawing: the text is kept
// as it was written, and a copy of the drawn rows gives that text back (copyReader). Each line of
// the text starts a row of its own, as a chat shows what was typed. The rows are blessed's
// tagged text, at most width columns each, so a pane never wraps them again.

// Marks the app puts on a character it draws in italics, struck through, or as a link
// (terminalStyles): code points no text keeps (any are taken out first), which the screen's
// output turns into the terminal's own codes and which a copy leaves out.
const FIRST_MARK = 0xe0100, LINK_DIGITS = 224, ITALIC = String.fromCodePoint(0xe01ef), STRIKE = String.fromCodePoint(0xe01ee);
const MARKS = /[\u{e0100}-\u{e01ef}]/gu, MARKED = /[\u{e0100}-\u{e01ef}]/u;
export const unmark = value => String(value ?? '').replace(MARKS, '');
// What the terminal draws: italics where it can, a link it can open (OSC 8) where it can. Off
// until the app's screen turns them on, so rows drawn without a screen hold no marks.
const styles = { italic: false, links: false };
const linkIds = new Map(), linkUrls = [];
// Whether this terminal draws italics and opens OSC 8 links. tmux, GNU screen and SSH may sit
// between the app and a terminal that could, and nothing says so: there a link shows its
// address. FORCE_HYPERLINK=1 or 0 says it for any terminal.
export function terminalStyles(env = process.env) {
  const term = String(env.TERM ?? '').toLowerCase(), between = Boolean(env.TMUX || env.STY || env.SSH_CONNECTION || env.SSH_TTY) || /^(?:screen|tmux)/.test(term);
  const forced = String(env.FORCE_HYPERLINK ?? '').trim();
  const opens = ['iTerm.app', 'WezTerm', 'vscode', 'ghostty'].includes(env.TERM_PROGRAM) || Boolean(env.KITTY_WINDOW_ID || env.WT_SESSION || env.ALACRITTY_WINDOW_ID) || ['xterm-kitty', 'xterm-ghostty', 'alacritty', 'wezterm'].includes(term) || Number(env.VTE_VERSION) >= 5000;
  return { italic: !env.STY && Boolean(term) && !/^(?:linux|dumb|vt\d*|ansi|cons\d*)$/.test(term), links: forced ? !/^(?:0|false|no)$/i.test(forced) : !between && !env.CI && opens };
}
// The terminal's codes for the marks on each run of characters the screen writes: a link opens
// and closes around the run, so a run never leaves one open whatever is drawn after it.
const RUN = /([^\x00-\x1f\x7f\u{e0100}-\u{e01ef}]\p{M}*?)([\u{e0100}-\u{e01ef}]+)/gu;
function drawMarks(text) {
  let out = '', from = 0, open = null, close = '', end = -1;
  for (const found of text.matchAll(RUN)) {
    if (open !== found[2] || found.index !== end) {
      if (open) out += close;
      out += text.slice(from, found.index);
      const marks = [...found[2]], flags = marks.filter(mark => mark.codePointAt(0) >= FIRST_MARK + LINK_DIGITS), digits = marks.filter(mark => mark.codePointAt(0) < FIRST_MARK + LINK_DIGITS);
      const id = digits.length === 2 ? (digits[0].codePointAt(0) - FIRST_MARK) * LINK_DIGITS + digits[1].codePointAt(0) - FIRST_MARK : -1, url = linkUrls[id];
      out += `${url ? `\x1b]8;id=elu-${id};${url}\x1b\\` : ''}${flags.includes(ITALIC) ? '\x1b[3m' : ''}${flags.includes(STRIKE) ? '\x1b[9m' : ''}`;
      close = `${flags.includes(STRIKE) ? '\x1b[29m' : ''}${flags.includes(ITALIC) ? '\x1b[23m' : ''}${url ? '\x1b]8;;\x1b\\' : ''}`;
      open = found[2];
    } else out += text.slice(from, found.index);
    out += found[1]; from = end = found.index + found[0].length;
  }
  return out + (open ? close : '') + text.slice(from);
}
// Turns the marks on for this screen, as far as the terminal draws them (terminalStyles).
export function installTerminalStyles(screen, found = terminalStyles()) {
  Object.assign(styles, { italic: found.italic === true, links: found.links === true });
  const program = screen?.program;
  if (!program || !(styles.italic || styles.links) || program.eluMarks) return;
  const write = program._owrite;
  program._owrite = function (text) { return write.call(this, typeof text === 'string' && MARKED.test(text) ? drawMarks(text) : text); };
  program.eluMarks = true;
}
// An address the terminal may open: the web or mail, printable, nothing that ends the link early.
const OPENS = /^(?:https?:\/\/|mailto:)[\x21-\x7e]+$/i;
function linkMark(url) {
  if (!styles.links || !OPENS.test(url) || /[\x1b\x07\\]/.test(url)) return '';
  let id = linkIds.get(url);
  if (id === undefined) { if (linkUrls.length >= LINK_DIGITS * LINK_DIGITS) return ''; id = linkUrls.length; linkUrls.push(url); linkIds.set(url, id); }
  return String.fromCodePoint(FIRST_MARK + Math.floor(id / LINK_DIGITS), FIRST_MARK + id % LINK_DIGITS);
}

// What a copy of a drawn row gives (lib/selection.mjs): the line of the text it was drawn from
// (or lines, for a table's header drawn as one rule), cont when the row carries on a line a row
// before it started, or skip for a row drawn only to frame (a table's top and bottom). Each
// drawing is kept whole, as the pane holds it, the newest 20,000 rows of them. A row is found by
// its place among the rows around it, never by what it shows alone: a blank line in code and the
// fence under it, a table's rule and a --- under it, draw alike and copy as their own lines.
const SKIP = Object.freeze({ skip: true }), KEPT_ROWS = 20000;
const drawings = new Map(); let keptRows = 0;
// Keeps a drawing as the newest, and lets the oldest go past 20,000 rows (never the newest).
function hold(value, drawing) {
  const had = drawings.get(value);
  if (had) { drawings.delete(value); keptRows -= had.size; }
  drawings.set(value, drawing); keptRows += drawing.size;
  for (const [old, kept] of drawings) { if (keptRows <= KEPT_ROWS || old === value) break; drawings.delete(old); keptRows -= kept.size; }
  return drawing;
}
// value: the drawing as the pane holds it (its rows joined by newlines); rows: what
// markdownRows gave for its rows from the row at from on (the rows before are a header).
// Returns the drawing, which keepDrawing keeps again when the same value is shown again.
// What each row copies as is worked out when a copy first reads it.
export function keepCopies(value, rows, from = 0) {
  const had = drawings.get(value);
  if (had) return hold(value, had);
  let size = 1; for (let at = value.indexOf('\n'); at >= 0; at = value.indexOf('\n', at + 1)) size++;
  let places = null;
  const drawing = { size, get places() { return places ??= Array.from({ length: size }, (_, at) => { const place = at < from ? null : rows?.copy?.[at - from]; return !place ? null : place.skip ? SKIP : { text: [place.line].flat().map(line => rows.source[line] ?? '').join('\n'), cont: place.cont }; }); } };
  return hold(value, drawing);
}
export const keepDrawing = (value, drawing) => drawing ? hold(value, drawing) : null;
export const drawingOf = value => drawings.get(value) ?? null;
// Reads a pane's lines for a copy: at => what that line copies as, or null when no kept drawing
// sits there whole. The newest drawing that matches every line it covers wins.
export function copyReader(lines) {
  let found = null, placed = [];
  // Every kept row, the newest drawing's first: where it sits in which drawing.
  const index = () => {
    if (found) return found;
    found = new Map();
    for (const [value, drawing] of [...drawings].reverse()) {
      const rows = value.split('\n');
      rows.forEach((row, at) => { const place = [rows, drawing, at], list = found.get(row); if (list) list.push(place); else found.set(row, [place]); });
    }
    return found;
  };
  const fits = (rows, start) => start >= 0 && start + rows.length <= lines.length && rows.every((row, at) => lines[start + at] === row);
  return at => {
    const line = lines[at];
    if (line === undefined) return null;
    for (const place of placed) if (at >= place.start && at < place.start + place.rows.length) return place.drawing.places[at - place.start];
    for (const [rows, drawing, offset] of index().get(line) ?? []) {
      if (fits(rows, at - offset)) { placed = [{ start: at - offset, rows, drawing }, ...placed.slice(0, 7)]; return drawing.places[offset]; }
    }
    return null;
  };
}
// The rows as one text for a pane, kept for a copy.
export function markdownText(text, width, options = {}) {
  const rows = markdownRows(text, width, options), value = rows.join('\n');
  keepCopies(value, rows);
  return value;
}

// Text as the app shows it: secrets masked unless trusted, and no control character or escape.
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
export const plainText = (value, { trusted = false } = {}) => (trusted ? String(value ?? '') : redact(String(value ?? ''), Infinity)).replace(CONTROLS, '');

const BRACE = /[{}]/, BRACES = /[{}]/g;
const esc = text => BRACE.test(text) ? text.replace(BRACES, ch => ch === '{' ? '{open}' : '{close}') : text;
const JOINED = ' ';
// A command the owner copies stays on one row (lib/terminal-visuals.mjs wrapText).
const COMMAND = /\b(?:(?:codex|grok|agy) login|claude auth login|elu [a-z]+)(?: (?:--[a-z][a-z-]*|@[\w-]+|[A-Z]{2,}\b))*/g;
// A tab as spaces to the next multiple of four, as the rest of the app draws one.
function untab(line) {
  if (!line.includes('\t')) return line;
  let out = '', used = 0;
  for (const part of line.split(/(\t)/)) { if (part === '\t') { const pad = 4 - used % 4; out += ' '.repeat(pad); used += pad; } else { out += part; used += columns(part); } }
  return out;
}

// Inline: the words of one line as styled runs. A run is { from, to, style } over the line's
// plain text, which is what shows: the stars, backticks and brackets are gone.
const ASCII_PUNCT = /[!-/:-@[-`{-~]/, SPACE = /\s/u, PUNCT = /[\p{P}\p{S}]/u;
const isSpace = ch => ch === undefined || SPACE.test(ch), isPunct = ch => ch !== undefined && PUNCT.test(ch);
const BARE = /(?:https?:\/\/|www\.)[^\s<]+/iy, AUTO = /<((?:https?|mailto):[^\s<>]*)>/iy;
function codeEnd(text, from, size) {
  for (let at = text.indexOf('`', from); at >= 0; at = text.indexOf('`', at)) {
    let end = at; while (text[end] === '`') end++;
    if (end - at === size) return at;
    at = end;
  }
  return -1;
}
// [label](address "title"), from the [ at start: the label, the address and where it ends.
function linkAt(text, start) {
  let depth = 0, at = start;
  // A label is looked for in the next few thousand characters only, so a line of many [ stays quick.
  for (; at < text.length && at - start < 2000; at++) {
    const ch = text[at];
    if (ch === '\\') { at++; continue; }
    if (ch === '`') { let end = at; while (text[end] === '`') end++; const close = codeEnd(text, end, end - at); if (close >= 0) { at = close + end - at - 1; continue; } at = end - 1; continue; }
    if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) break;
  }
  if (depth !== 0 || text[at + 1] !== '(') return null;
  const label = text.slice(start + 1, at);
  let pos = at + 2; while (text[pos] === ' ') pos++;
  let url = '';
  if (text[pos] === '<') { const close = text.indexOf('>', pos); if (close < 0) return null; url = text.slice(pos + 1, close); pos = close + 1; }
  else {
    let parens = 0;
    for (; pos < text.length && url.length < 4000; pos++) {
      const ch = text[pos];
      if (ch === '\\' && ASCII_PUNCT.test(text[pos + 1] ?? '')) { url += text[pos + 1]; pos++; continue; }
      if (/\s/.test(ch)) break;
      if (ch === '(') parens++;
      else if (ch === ')') { if (!parens) break; parens--; }
      url += ch;
    }
  }
  while (text[pos] === ' ') pos++;
  if (`"'(`.includes(text[pos]) && pos < text.length) { const close = text.indexOf(text[pos] === '(' ? ')' : text[pos], pos + 1); if (close < 0) return null; pos = close + 1; while (text[pos] === ' ') pos++; }
  return text[pos] === ')' ? { label, url, end: pos + 1 } : null;
}
// Where something other than plain words may start: the text between is taken whole.
const SPECIAL = /[\\`[!<*_~]|(?<![\p{L}\p{N}_/.@-])(?:https?:\/\/|www\.)/giu;
function tokens(text, depth = 0) {
  const out = []; let buf = '';
  const flush = () => { if (buf) { out.push({ type: 'text', text: buf }); buf = ''; } };
  for (let at = 0; at < text.length;) {
    SPECIAL.lastIndex = at; const next = SPECIAL.exec(text);
    if (!next) { buf += text.slice(at); break; }
    if (next.index > at) { buf += text.slice(at, next.index); at = next.index; }
    const ch = text[at];
    if (ch === '\\' && ASCII_PUNCT.test(text[at + 1] ?? '')) { buf += text[at + 1]; at += 2; continue; }
    if (ch === '`') {
      let end = at; while (text[end] === '`') end++;
      const close = codeEnd(text, end, end - at);
      if (close < 0) { buf += text.slice(at, end); at = end; continue; }
      let code = text.slice(end, close);
      if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
      flush(); out.push({ type: 'code', text: code }); at = close + end - at; continue;
    }
    if ((ch === '[' || ch === '!' && text[at + 1] === '[') && depth < 4) {
      const link = linkAt(text, ch === '!' ? at + 1 : at);
      if (link) { flush(); out.push({ type: 'link', url: link.url, children: emphasis(tokens(link.label || (ch === '!' ? 'image' : link.url), depth + 1)) }); at = link.end; continue; }
    }
    if (ch === '<') { AUTO.lastIndex = at; const found = AUTO.exec(text); if (found) { flush(); out.push({ type: 'link', url: found[1], children: [{ type: 'text', text: found[1] }] }); at = AUTO.lastIndex; continue; } }
    if ((ch === 'h' || ch === 'H' || ch === 'w' || ch === 'W') && !/[\p{L}\p{N}_/.@-]/u.test(text[at - 1] ?? '')) {
      BARE.lastIndex = at; const found = BARE.exec(text);
      if (found) {
        // The punctuation that ends a sentence, and a ) the address did not open, are not part of it.
        let url = found[0].replace(/[?!.,:;*_~'"\]]+$/, '');
        while (url.endsWith(')') && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length) url = url.slice(0, -1).replace(/[?!.,:;*_~'"\]]+$/, '');
        if (url.includes('.') && url.length > 7) { flush(); out.push({ type: 'link', url: /^www\./i.test(url) ? `https://${url}` : url, children: [{ type: 'text', text: url }] }); at += url.length; continue; }
      }
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      let end = at; while (text[end] === ch) end++;
      const before = text[at - 1], after = text[end], count = end - at;
      const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before)), right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
      const open = ch === '_' ? left && (!right || isPunct(before)) : left, close = ch === '_' ? right && (!left || isPunct(after)) : right;
      if ((open || close) && (ch !== '~' || count === 2)) { flush(); out.push({ type: 'delim', ch, count, open, close }); at = end; continue; }
      buf += text.slice(at, end); at = end; continue;
    }
    buf += ch; at++;
  }
  flush();
  return out;
}
// Pairs the runs of * _ ~ that open and close (CommonMark's rules, without the rule of three).
function emphasis(list) {
  for (let at = 0; at < list.length; at++) {
    const closer = list[at];
    if (closer.type !== 'delim' || !closer.close || !closer.count) continue;
    let from = at - 1;
    while (from >= 0 && !(list[from].type === 'delim' && list[from].ch === closer.ch && list[from].open && list[from].count)) from--;
    if (from < 0) continue;
    const opener = list[from], use = opener.ch === '~' ? 2 : opener.count >= 2 && closer.count >= 2 ? 2 : 1;
    const inner = list.slice(from + 1, at).map(row => row.type === 'delim' ? { type: 'text', text: row.ch.repeat(row.count) } : row);
    opener.count -= use; closer.count -= use;
    list.splice(from + 1, at - from - 1, { type: opener.ch === '~' ? 'strike' : use === 2 ? 'strong' : 'em', children: inner });
    at = from + 1;
  }
  return list.map(row => row.type === 'delim' ? row.count ? { type: 'text', text: row.ch.repeat(row.count) } : null : row).filter(Boolean);
}
// The plain text of a line and its styled runs. base: the style of the whole line. A link the
// terminal cannot open shows its address after its words, muted; inline code without colour
// keeps its backticks.
function inline(line, base, colour) {
  let plain = ''; const runs = [];
  const add = (text, style) => { if (!text) return; runs.push({ from: plain.length, to: plain.length + text.length, style }); plain += text; };
  const walk = (list, style) => {
    for (const row of list) {
      if (row.type === 'text') add(row.text, style);
      else if (row.type === 'code') add(colour ? row.text : `\`${row.text}\``, { ...style, code: true });
      else if (row.type === 'link') {
        const start = plain.length, mark = linkMark(row.url);
        walk(row.children, { ...style, link: true, mark: mark || null });
        const said = plain.slice(start).trim();
        if (!mark && row.url && said !== row.url && `https://${said}` !== row.url) add(` (${row.url})`, { ...style, link: false, address: true });
      }
      else walk(row.children, { ...style, ...(row.type === 'strong' ? { bold: true } : row.type === 'em' ? { italic: true } : { strike: true }) });
    }
  };
  walk(emphasis(tokens(line)), base);
  return { plain: plain.replace(COMMAND, command => command.replaceAll(' ', JOINED)), runs };
}
// Where a line of plain text breaks into rows of room columns (rest: the rows after the first):
// at the last space that fits, else between two characters. Walked once, as wrapText walks; a
// line of printable ASCII alone, a column a character, is counted at once.
const ASCII = /^[\x20-\x7e]*$/;
function breaks(line, room, rest = room) {
  const out = [], ascii = ASCII.test(line);
  for (let at = 0, first = true; at < line.length || first; first = false) {
    const width = Math.max(1, first ? room : rest);
    let end = at, used = 0;
    if (ascii) end = Math.min(line.length, at + width);
    else while (end < line.length) { const unit = unitAt(line, end) || line[end], size = unitWidth(unit); if (used + size > width) break; end += unit.length; used += size; }
    if (end >= line.length) { out.push([at, line.length]); break; }
    if (end === at) end = at + (unitAt(line, at).length || 1);
    const space = line.slice(at, end).lastIndexOf(' '), stop = line[end] !== ' ' && space > 0 ? at + space : end;
    let right = stop; while (right > at && line[right - 1] === ' ') right--;
    out.push([at, right]);
    at = stop; while (at < line.length && line[at] === ' ') at++;
    if (at >= line.length) break;
  }
  return out;
}
const HEADING_TONE = 'gold', CODE_TONE = 'rose', LINK_TONE = 'blue', CODE_BG = 236, BLOCK_BG = 235;
// Tags around a piece of a row in its style.
function paint(text, style, colour) {
  if (!text) return '';
  const raw = text.includes(JOINED) ? text.replaceAll(JOINED, ' ') : text, marks = `${style.mark ?? ''}${style.italic && styles.italic ? ITALIC : ''}${style.strike && styles.italic ? STRIKE : ''}`;
  // A mark goes on each character it styles; a brace is drawn by a tag and takes none.
  const shown = marks ? units(raw).map(unit => unit === '{' || unit === '}' ? esc(unit) : unit + marks).join('') : esc(raw);
  const tone = style.address || style.strike ? 'muted' : style.link ? LINK_TONE : style.code ? CODE_TONE : style.heading ? HEADING_TONE : style.tone;
  const fg = colour && tone && PALETTE[tone] !== undefined ? PALETTE[tone] : null, bg = colour && style.code;
  const bold = style.bold || style.heading, underline = style.link || style.heading === 1;
  return `${fg !== null ? `{${fg}-fg}` : ''}${bg ? `{${CODE_BG}-bg}` : ''}${bold ? '{bold}' : ''}${underline ? '{underline}' : ''}${shown}${underline ? '{/underline}' : ''}${bold ? '{/bold}' : ''}${bg ? `{/${CODE_BG}-bg}` : ''}${fg !== null ? `{/${fg}-fg}` : ''}`;
}
// The row of a line's runs between from and to. Rows come in order, so the runs before the last
// row's are not looked at again (first: the run to start from, kept on the line).
function rowOf(line, from, to, colour) {
  const { plain, runs } = line; let out = '', at = line.first ?? 0;
  while (at < runs.length && runs[at].to <= from) at++;
  line.first = at;
  for (; at < runs.length && runs[at].from < to; at++) {
    const run = runs[at], a = Math.max(from, run.from), b = Math.min(to, run.to);
    if (a < b) out += paint(plain.slice(a, b), run.style, colour);
  }
  return out;
}
// A line of words as rows: the first after lead, the rest after hang (both already drawn, with
// their widths), each at most width columns in all.
function flow(line, width, colour, { lead = ['', 0], hang = ['', 0] } = {}) {
  line.first = 0;
  return breaks(line.plain, width - lead[1], width - hang[1]).map(([from, to], index) => (index ? hang[0] : lead[0]) + rowOf(line, from, to, colour));
}

// Blocks. Each is a run of the text's lines; a row keeps the line it came from (src) for a copy.
const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`]*?)[ \t]*$/, HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/, RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/, ITEM = /^( *)([-*+•]|\d{1,9}[.)])(?:[ \t]+(.*))?$/, DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const BULLETS = ['•', '◦', '▪'];
const indentOf = text => /^ */.exec(text)[0].length;
// The first line after from that is not blank.
// The next line after from that is not blank (an as-written line counts as one that ends the block).
const filled = (lines, from) => { for (let at = from + 1; at < lines.length; at++) if (lines[at].text.trim()) return lines[at]; return null; };
// A table row's cells, split at each | that is not escaped or inside inline code.
function cellsOf(text) {
  let line = text.trim(); if (line.startsWith('|')) line = line.slice(1);
  if (line.endsWith('|') && !line.endsWith('\\|')) line = line.slice(0, -1);
  const out = []; let cell = '', code = 0;
  for (let at = 0; at < line.length; at++) {
    const ch = line[at];
    if (ch === '\\' && line[at + 1] === '|') { cell += '|'; at++; continue; }
    if (ch === '`') { let end = at; while (line[end] === '`') end++; const size = end - at; code = code === size ? 0 : code || (codeEnd(line, end, size) >= 0 ? size : 0); cell += line.slice(at, end); at = end - 1; continue; }
    if (ch === '|' && !code) { out.push(cell.trim()); cell = ''; continue; }
    cell += ch;
  }
  out.push(cell.trim());
  return out;
}
function render(lines, width, ctx, depth = 0) {
  const out = [], { colour } = ctx;
  const put = (row, src, cont = false) => out.push({ row, src, cont });
  const frame = colour ? 'dim' : null, line = text => colour ? `{${PALETTE[frame]}-fg}${text}{/${PALETTE[frame]}-fg}` : text;
  for (let at = 0; at < lines.length;) {
    const { text, src } = lines[at];
    if (!text.trim()) { if (out.length && out.at(-1).row !== '') put('', src); at++; continue; }
    if (lines[at].plain || ctx.inline || depth > 8) {
      const lead = ' '.repeat(Math.min(indentOf(text), Math.floor(width / 2))), words = lines[at].plain ? { plain: text.trimStart(), runs: [{ from: 0, to: text.trimStart().length, style: ctx.base }] } : inline(text.trimStart(), ctx.base, colour);
      flow(words, width, colour, { lead: [lead, lead.length], hang: [lead, lead.length] }).forEach((row, index) => put(row, src, index > 0)); at++; continue;
    }
    const fence = FENCE.exec(text);
    if (fence) {
      // Code keeps its lines as written, on a shaded block; a line too long for it carries on
      // under ↪. The block's top row holds its language, its bottom row nothing.
      const [, indent, mark, info] = fence, inner = Math.max(4, width - 2), body = [];
      const closing = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}[ \\t]*$`), margin = new RegExp(`^ {0,${indent.length}}`);
      let end = at + 1;
      while (end < lines.length && !lines[end].plain && !closing.test(lines[end].text)) body.push(lines[end++]);
      // size: the columns the row shows; the shade runs on to the block's right edge.
      const shade = (row, size) => colour ? `{${BLOCK_BG}-bg} ${row}${' '.repeat(Math.max(0, width - 1 - size))}{/${BLOCK_BG}-bg}` : `  ${row}`;
      const label = info.split(/\s/)[0];
      put(shade(paint(label, { tone: 'muted' }, colour), columns(label)), src);
      for (const code of body) {
        const raw = code.text.replace(margin, '');
        if (!raw) { put(shade('', 0), code.src); continue; }
        breaks(raw.replaceAll(' ', JOINED), inner, inner - 2).forEach(([from, to], index) => { const piece = raw.slice(from, to); put(shade(`${index ? paint('↪ ', { tone: 'muted' }, colour) : ''}${esc(piece)}`, columns(piece) + (index ? 2 : 0)), code.src, index > 0); });
      }
      const closed = end < lines.length && !lines[end].plain;
      out.push({ row: shade('', 0), ...(closed ? { src: lines[end].src } : { skip: true }) });
      at = closed ? end + 1 : end; continue;
    }
    const heading = HEADING.exec(text);
    if (heading) {
      const level = heading[1].length, words = inline(heading[2] ?? '', { ...ctx.base, heading: level }, colour);
      flow(words, width, colour).forEach((row, index) => put(row, src, index > 0)); at++; continue;
    }
    if (RULE.test(text)) { put(line('─'.repeat(width)), src); at++; continue; }
    const quote = QUOTE.exec(text);
    if (quote) {
      const inside = [];
      while (at < lines.length && !lines[at].plain && QUOTE.test(lines[at].text)) inside.push({ text: QUOTE.exec(lines[at].text)[1], src: lines[at++].src });
      const bar = line('│') + ' ';
      for (const row of render(inside, width - 2, { ...ctx, base: { ...ctx.base, tone: 'muted' } }, depth + 1)) out.push({ ...row, row: bar + row.row });
      continue;
    }
    if (text.includes('|') && at + 1 < lines.length && !lines[at + 1].plain && DELIMITER.test(lines[at + 1].text) && lines[at + 1].text.includes('|') && cellsOf(lines[at + 1].text).length === cellsOf(text).length) {
      let end = at + 2; while (end < lines.length && !lines[end].plain && lines[end].text.trim() && lines[end].text.includes('|')) end++;
      out.push(...table(lines.slice(at, end), width, ctx));
      at = end; continue;
    }
    const item = ITEM.exec(text);
    if (item && !RULE.test(text)) {
      // A list: each item behind its bullet or number, its rows under its own text; a line
      // indented more than the item's marker carries it on or starts a list inside it.
      const base = indentOf(text), ordered = /\d/.test(item[2]), items = [];
      let end = at;
      while (end < lines.length) {
        const found = ITEM.exec(lines[end].text);
        if (!found || lines[end].plain || indentOf(lines[end].text) !== base || /\d/.test(found[2]) !== ordered || RULE.test(lines[end].text)) break;
        const body = [{ text: found[3] ?? '', src: lines[end].src }], column = base + found[2].length + 1;
        end++;
        for (; end < lines.length; end++) {
          const next = lines[end].text;
          if (!next.trim()) { const after = filled(lines, end); if (after && !after.plain && indentOf(after.text) > base) { body.push({ text: '', src: lines[end].src }); continue; } break; }
          if (lines[end].plain || indentOf(next) <= base) break;
          body.push({ text: next.slice(Math.min(indentOf(next), column)), src: lines[end].src });
        }
        items.push({ mark: found[2], body });
        // A blank line between two items of the list stays one.
        if (end < lines.length && !lines[end].text.trim()) { const after = filled(lines, end), next = after && !after.plain && ITEM.exec(after.text); if (next && indentOf(after.text) === base && /\d/.test(next[2]) === ordered) { items.at(-1).gap = lines[end].src; end = lines.indexOf(after, end); } }
      }
      const start = ordered ? Number.parseInt(items[0].mark, 10) : 0, delim = ordered ? items[0].mark.at(-1) : '';
      const marks = items.map((row, index) => ordered ? `${start + index}${delim}` : BULLETS[ctx.list % BULLETS.length]);
      const wide = Math.max(...marks.map(mark => columns(mark)));
      items.forEach((row, index) => {
        let mark = marks[index], tone = 'muted', body = row.body;
        // A task in a list: [ ] to do, [x] done.
        const task = /^\[([ xX])\][ \t]+/.exec(body[0].text);
        if (task && !ordered) { mark = task[1] === ' ' ? '○' : '✓'; tone = task[1] === ' ' ? 'muted' : 'green'; body = [{ ...body[0], text: body[0].text.slice(task[0].length) }, ...body.slice(1)]; }
        const lead = `${' '.repeat(wide - columns(mark))}${mark} `, hang = ' '.repeat(columns(lead));
        const rows = render(body, width - columns(lead), { ...ctx, list: ctx.list + 1 }, depth + 1);
        if (!rows.length) rows.push({ row: '', src: body[0].src, cont: false });
        rows.forEach((row, place) => out.push({ ...row, row: (place ? hang : paint(lead, { tone }, colour)) + row.row }));
        if (row.gap !== undefined && index < items.length - 1) put('', row.gap);
      });
      at = end; continue;
    }
    // A line of words: wrapped at width, its rows under its first word when it starts indented.
    const lead = ' '.repeat(Math.min(indentOf(text), Math.floor(width / 2))), words = inline(text.trimStart(), ctx.base, colour);
    flow(words, width, colour, { lead: [lead, lead.length], hang: [lead, lead.length] }).forEach((row, index) => put(row, src, index > 0));
    at++;
  }
  return out;
}
// A table fitted to width: each column as wide as its widest cell, until they do not fit; then
// the widest columns give way first and their cells wrap, each keeping its words whole up to ten
// columns or its share of the width, a longer word wrapping inside its cell. Only a width of
// fewer than three characters a column lists each row's cells under the header's names instead.
function table(lines, width, ctx) {
  const { colour } = ctx, header = cellsOf(lines[0].text), count = header.length;
  const aligns = cellsOf(lines[1].text).map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
  const rows = [header, ...lines.slice(2).map(row => cellsOf(row.text))].map(cells => Array.from({ length: count }, (_, at) => cells[at] ?? ''));
  const srcs = [lines[0].src, ...lines.slice(2).map(row => row.src)];
  const words = rows.map((cells, index) => cells.map(cell => inline(cell, index ? ctx.base : { ...ctx.base, bold: true }, colour)));
  const natural = Array.from({ length: count }, (_, col) => Math.max(1, ...words.map(cells => columns(cells[col].plain))));
  const room = width - (3 * count + 1), out = [], most = Math.max(10, Math.floor(room / count)), sum = list => list.reduce((total, size) => total + size, 0);
  const longest = Array.from({ length: count }, (_, col) => Math.max(1, ...words.map(cells => Math.max(0, ...cells[col].plain.split(/\s+/u).map(word => columns(word))))));
  // Each column keeps its longest word whole where they all fit; else its words up to a tenth of
  // the line or the column's share of it, and a longer word wraps inside its cell.
  const even = Math.max(1, Math.floor(room / count));
  const floor = [longest, longest.map(size => Math.min(size, most)), longest.map(size => Math.min(size, even))].find(list => sum(list) <= room);
  const tone = text => colour ? `{${PALETTE.dim}-fg}${text}{/${PALETTE.dim}-fg}` : text;
  // Too narrow for three characters a column: each row lists its cells by their names.
  if (room < count * 3) {
    // The header and its rule copy as the rule over the rows. A name too long to share its row
    // has the cell under it.
    out.push({ row: tone('─'.repeat(width)), src: [lines[0].src, lines[1].src] });
    words.slice(1).forEach((cells, index) => {
      cells.forEach((cell, col) => {
        const name = `${words[0][col].plain || `Column ${col + 1}`}: `, said = paint(name, { tone: 'muted', bold: true }, colour), alone = columns(name) > width / 2;
        if (alone) out.push({ row: said, src: srcs[index + 1], cont: col > 0 });
        flow(cell, width, colour, { lead: alone ? ['  ', 2] : [said, columns(name)], hang: ['  ', 2] }).forEach((row, at) => out.push({ row, src: srcs[index + 1], cont: col > 0 || at > 0 || alone }));
      });
      out.push({ row: tone('─'.repeat(width)), src: srcs[index + 1], cont: true });
    });
    return out;
  }
  // Each column keeps its floor; above that the widest a column may be so that all fit (cap),
  // then the columns cut to it share what is left.
  const widths = natural.slice();
  if (natural.reduce((sum, size) => sum + size, 0) > room) {
    const at = cap => natural.map((size, col) => Math.max(floor[col], Math.min(size, cap)));
    let low = 1, high = Math.max(...natural);
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (at(mid).reduce((sum, size) => sum + size, 0) <= room) low = mid; else high = mid - 1; }
    at(low).forEach((size, col) => { widths[col] = size; });
    let left = room - widths.reduce((sum, size) => sum + size, 0);
    for (let col = 0; left > 0 && col < count; col++) if (natural[col] > widths[col]) { widths[col]++; left--; }
  }
  const rule = (a, b, c) => tone(`${a}${widths.map(size => '─'.repeat(size + 2)).join(b)}${c}`), blank = new RegExp(`\\{/${PALETTE.dim}-fg\\}( +)\\{${PALETTE.dim}-fg\\}`, 'g');
  out.push({ row: rule('┌', '┬', '┐'), skip: true });
  words.forEach((cells, index) => {
    const wrapped = cells.map((cell, col) => breaks(cell.plain, widths[col]).map(([from, to]) => ({ text: rowOf(cell, from, to, colour), size: columns(cell.plain.slice(from, to)) })));
    const high = Math.max(...wrapped.map(parts => parts.length));
    for (let at = 0; at < high; at++) {
      const row = wrapped.map((parts, col) => {
        const part = parts[at] ?? { text: '', size: 0 }, gap = widths[col] - part.size, align = aligns[col] ?? 'left';
        const before = align === 'right' ? gap : align === 'center' ? Math.floor(gap / 2) : 0;
        return `${' '.repeat(before)}${part.text}${' '.repeat(gap - before)}`;
      });
      // A cell with nothing on this row takes the lines' colour, so the row holds fewer tags.
      out.push({ row: (tone('│ ') + row.join(tone(' │ ')) + tone(' │')).replace(blank, '$1'), src: srcs[index], cont: at > 0 });
    }
    if (!index) out.push({ row: rule('├', '┼', '┤'), src: lines[1].src });
  });
  out.push({ row: rule('└', '┴', '┘'), skip: true });
  return out;
}

// A text inside one drawn as Markdown that shows as written, as the owner's own message in a
// thread does: each of its lines starts with a mark that shows nowhere and copies as nothing.
const AS_WRITTEN = '';
export const asWritten = text => String(text ?? '').split('\n').map(line => AS_WRITTEN + line).join('\n');
// A text drawn as written on a shaded block, whatever it holds (a script): fenced with more
// backticks than any run of them in it, so none of its lines closes the block.
export function codeBlock(text) {
  const body = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, ''), mark = '`'.repeat(Math.max(2, ...(body.match(/`+/g) ?? []).map(run => run.length)) + 1);
  return `${mark}\n${body}\n${mark}`;
}
// The rows of a text drawn as Markdown at width columns, as blessed's tagged text. options:
// colour; tone and bold, the style of its plain words (the pane's own when left out); inline,
// to draw only the words of each line (bold, code, links), for a line that is a field of
// something else. The rows also say which line of the text each came from (copy, source).
export function markdownRows(text, width, { colour = true, tone = null, bold = false, inline: only = false } = {}) {
  width = Math.max(8, Math.floor(width) || 8);
  const given = unmark(String(text ?? '').replace(/\r\n?/g, '\n')).replace(CONTROLS, '').split('\n'), plain = given.map(line => line.startsWith(AS_WRITTEN));
  const source = given.map((line, at) => plain[at] ? line.slice(AS_WRITTEN.length) : line);
  const rows = render(source.map((value, src) => ({ text: untab(value).replace(/\s+$/, ''), src, plain: plain[src] })), width, { colour, base: { tone, bold }, inline: only, list: 0 });
  while (rows.length > 1 && rows.at(-1).row === '') rows.pop();
  return Object.assign(rows.map(row => row.row), { copy: rows.map(row => row.skip ? { skip: true } : { line: row.src, cont: row.cont === true }), source });
}
// A text as one line of plain words, for a row that shows only its start: no stars, backticks,
// #s or table rules, a list's items after •.
export function markdownLine(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || FENCE.test(line) || RULE.test(line) || DELIMITER.test(line) && line.includes('-')) continue;
    const heading = HEADING.exec(line), item = ITEM.exec(line), quote = QUOTE.exec(line);
    const words = heading ? heading[2] ?? '' : item ? `${/\d/.test(item[2]) ? item[2] : '•'} ${item[3] ?? ''}` : quote ? quote[1] : line.includes('|') && /^\|.*\|$/.test(line) ? cellsOf(line).join(' · ') : line;
    out.push(inline(words, {}, true).plain.replaceAll(JOINED, ' '));
  }
  return out.join(' ');
}
