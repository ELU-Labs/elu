import { spawn } from 'node:child_process';

// Drag to select and copy, the way a terminal does, kept inside the pane you started in.
// A double click takes a word, a triple click the row. The copy happens when you let go.

const INVERSE = 8 << 18;
const ESCAPES = /\x1b\[[\d;]*m/g;

// The cells from a to b in reading order, clamped to the pane: [y, from, to] per row.
export function spans(rect, a, b) {
  let [start, end] = a.y < b.y || a.y === b.y && a.x <= b.x ? [a, b] : [b, a];
  if (start.y < rect.y0) start = { x: rect.x0, y: rect.y0 };
  if (end.y > rect.y1) end = { x: rect.x1, y: rect.y1 };
  const rows = [];
  for (let y = Math.max(start.y, rect.y0); y <= Math.min(end.y, rect.y1); y++) {
    const from = Math.max(rect.x0, y === start.y ? start.x : rect.x0), to = Math.min(rect.x1, y === end.y ? end.x : rect.x1);
    if (from <= to) rows.push([y, from, to]);
  }
  return rows;
}
// The text in those cells. joinAt(y) says how row y joins the one above: '\n', or '' / ' ' at a soft wrap.
// clean(row) takes out what is drawn beside the text and is not part of it, such as a message's bar.
export function spanText(lines, rows, joinAt = () => '\n', clean = row => row) {
  let text = '';
  rows.forEach(([y, from, to], index) => {
    const cells = lines[y] ?? [];
    let row = '';
    for (let x = from; x <= to && x < cells.length; x++) if (cells[x][1] !== '\x03') row += cells[x][1];
    text += (index ? joinAt(y) : '') + clean(row).replace(/\s+$/, '');
  });
  return text;
}
// The word around x in a row of cells, as [from, to].
export function wordSpan(cells, x, x0, x1) {
  const solid = at => at >= x0 && at <= x1 && cells[at] && /\S/.test(cells[at][1]) && cells[at][1] !== '\x03' || cells[at]?.[1] === '\x03';
  if (!solid(x)) return null;
  let from = x, to = x;
  while (solid(from - 1)) from--;
  while (solid(to + 1)) to++;
  return [from, to];
}

// The clipboard: pbcopy on macOS, else the terminal's OSC 52. Tests pass their own.
export function systemClipboard({ write, platform = process.platform } = {}) {
  const osc = text => write?.(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
  return text => {
    if (platform !== 'darwin') return osc(text);
    try { const child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] }); child.on('error', () => osc(text)); child.stdin.on('error', () => {}); child.stdin.end(text); }
    catch { osc(text); }
  };
}

// The pane a cell belongs to: the deepest element there, or the nearest scrolling or bordered
// one around it. blessed draws a scrollbar over a pane's last column only while its text is
// taller than the pane; otherwise text fills that column and a selection takes it.
const barShown = (pane, pos) => Boolean(pane.scrollbar) && Math.max(pane._clines?.length ?? 0, pane._scrollBottom?.() ?? 0) > pos.yl - pos.yi - pane.iheight;
function paneAt(screen, x, y) {
  let found = null;
  const walk = el => {
    for (const child of el.children ?? []) {
      if (child.detached || child.hidden || !child.visible) continue;
      const pos = child.lpos;
      if (pos && x >= pos.xi && x < pos.xl && y >= pos.yi && y < pos.yl) found = child;
      walk(child);
    }
  };
  walk(screen);
  let pane = found;
  while (pane && pane !== screen && !pane.selectText && !pane.scrollable && !pane.border) pane = pane.parent;
  if (!pane || pane === screen || !pane.lpos) return { el: null, rect: { x0: 0, y0: 0, x1: screen.width - 1, y1: screen.height - 1 } };
  const pos = pane.lpos;
  return { el: pane, rect: { x0: pos.xi + pane.ileft, y0: pos.yi + pane.itop, x1: pos.xl - 1 - pane.iright - (barShown(pane, pos) ? 1 : 0), y1: pos.yl - 1 - pane.ibottom } };
}
// Rows wrapped by blessed join without a newline; a space dropped at the wrap comes back.
function joiner(el) {
  const lines = el?._clines, pos = el?.lpos;
  if (!lines?.rtof || !pos) return () => '\n';
  return y => {
    const row = y - pos.yi - el.itop + (el.childBase || 0);
    if (row <= 0 || lines.rtof[row] === undefined || lines.rtof[row] !== lines.rtof[row - 1]) return '\n';
    return /\s$/.test(String(lines[row - 1] ?? '').replace(ESCAPES, '')) ? ' ' : '';
  };
}

// The report's button code without the protocol offset: SGR sends it as is; X10, UTF-8 and
// urxvt add 32. Bit 32 of the code means the mouse moved with a button held (a drag).
export function buttonCode(data) {
  if (!data?.raw) return 0;
  return data.type === 'sgr' ? data.raw[0] : data.raw[0] - 32;
}

// One mouse report in a form blessed reads: SGR, urxvt, or X10 with three coordinates (in the
// UTF-8 form a coordinate past 95 is two bytes). Matched on the bytes as latin1 text.
const REPORT = /\x1b\[<(\d+);\d+;\d+([mM])|\x1b\[(\d+);\d+;\d+M|\x1b\[M((?:[\xc2-\xdf][\x80-\xbf]|[\x00-\xff]){3})/g;
// The start of a report that the end of a read cut off. No key begins this way.
const CUT = /\x1b\[<[\d;]*$|\x1b\[M(?:[\xc2-\xdf][\x80-\xbf]|[\x00-\xff]){0,2}$/;

// Splits each read of input into the parts blessed can take one at a time: every mouse report
// on its own, and the keys between them. blessed reads one report from the start of a read
// and drops the rest, so a release that arrived with the last drag report was lost, and the
// drag never ended. Of a run of motion reports only the last is passed on. A report cut by
// the end of a read waits for the rest of it.
export function reportSplitter() {
  let held = Buffer.alloc(0);
  return chunk => {
    const fresh = typeof chunk === 'string' ? Buffer.from(chunk) : chunk, data = held.length ? Buffer.concat([held, fresh]) : fresh;
    held = Buffer.alloc(0);
    const text = data.toString('latin1'), parts = [];
    let at = 0, last = null;
    const keys = to => { if (to > at) { parts.push(data.subarray(at, to)); last = null; } };
    for (const found of text.matchAll(REPORT)) {
      keys(found.index);
      // The button code with the motion bit: SGR and urxvt as sent, X10 less its offset of 32.
      const code = found[1] !== undefined ? Number(found[1]) : found[3] !== undefined ? Number(found[3]) - 32 : found[4].charCodeAt(0) - 32;
      const motion = Boolean(code & 32) && found[2] !== 'm' ? code : null;
      const part = data.subarray(found.index, found.index + found[0].length);
      if (motion !== null && motion === last) parts[parts.length - 1] = part; else parts.push(part);
      last = motion; at = found.index + found[0].length;
    }
    const cut = text.slice(at).search(CUT);
    if (cut >= 0) { keys(at + cut); held = Buffer.from(data.subarray(at + cut)); } else keys(text.length);
    return parts;
  };
}
// Passes every read of the screen's input through reportSplitter, to all that listen to it:
// blessed's mouse and key readers, and the paste reader. Call it once they are attached.
export function attachReports(screen) {
  const input = screen.program.input, readers = input.listeners('data');
  if (!readers.length) return;
  const split = reportSplitter(), each = chunk => { for (const part of split(chunk)) for (const reader of readers) reader.call(input, part); };
  for (const reader of readers) input.removeListener('data', reader);
  input.on('data', each);
  const destroy = screen.destroy.bind(screen);
  screen.destroy = function() { input.removeListener('data', each); return destroy(); };
}

export function attachSelection(screen, { copy, onCopy, clean } = {}) {
  // blessed asks xterm-like terminals for UTF-8 reports; SGR has no column limit, so ask for it too.
  // The mode joins the ones blessed resets on exit.
  if (screen.program.mouseEnabled) screen.program.setMouse({ sgrMouse: true }, true);
  let pane = null, anchor = null, head = null, dragging = false, moved = false, shown = [], last = { at: 0, x: -1, y: -1, count: 0 };
  const selected = () => pane && anchor && head ? spans(pane.rect, anchor, head) : [];
  // Just before each frame is drawn the selected cells are inverted; once it is out they go
  // back, so the buffer always holds the real text. Elements have all rendered by then.
  const invert = () => { for (const [y, from, to] of shown) { const cells = screen.lines[y]; if (!cells) continue; for (let x = from; x <= to && x < cells.length; x++) cells[x][0] ^= INVERSE; cells.dirty = true; } };
  const draw = screen.draw.bind(screen);
  screen.draw = function(start, end) { shown = selected(); invert(); return draw(start, end); };
  screen.on('render', () => { invert(); for (const [y] of shown) if (screen.lines[y]) screen.lines[y].dirty = false; });
  const clear = () => {
    if (!anchor) return;
    for (const [y] of shown) if (screen.lines[y]) screen.lines[y].dirty = true;
    pane = anchor = head = null; shown = []; screen.render();
  };
  // The pane and the first and last selected cells, or null.
  const range = () => {
    const rows = selected(); if (!rows.length) return null;
    const first = rows[0], end = rows.at(-1);
    return { el: pane.el, from: { x: first[1], y: first[0] }, to: { x: end[2], y: end[0] } };
  };
  // The cells as they are on the terminal. Setting a pane's content blanks its cells until
  // the next frame, and the app sets content on a timer without drawing when nothing
  // changed. Drawing first makes the cells hold the text again.
  const cells = () => { screen.render(); return screen.lines; };
  const text = () => {
    const rows = selected(); if (!rows.length) return '';
    if (pane.el?.selectText) { const { from, to } = range(); return pane.el.selectText(from, to); }
    return spanText(cells(), rows, joiner(pane.el), clean);
  };
  const finish = () => { const value = text(); if (value) { copy?.(value); onCopy?.(value); } };
  screen.program.prependListener('mouse', data => {
    const motion = data.action === 'mousemove' || data.action === 'mousedown' && Boolean(buttonCode(data) & 32);
    if (data.action === 'wheelup' || data.action === 'wheeldown') { clear(); return; }
    if (motion) {
      if (!dragging) return;
      if (data.button !== 'left' && data.action === 'mousemove') { dragging = false; if (moved) finish(); return; }
      data.action = 'mousedrag';
      if (head && head.x === data.x && head.y === data.y) return;
      head = { x: data.x, y: data.y }; moved = true; screen.render(); return;
    }
    if (data.action === 'mousedown') {
      if (data.button !== 'left') return;
      const now = Date.now(), again = now - last.at < 500 && last.x === data.x && last.y === data.y;
      last = { at: now, x: data.x, y: data.y, count: again ? last.count + 1 : 1 };
      clear();
      pane = paneAt(screen, data.x, data.y); dragging = true; moved = false;
      if (last.count === 2) {
        const span = wordSpan(cells()[data.y] ?? [], data.x, pane.rect.x0, pane.rect.x1);
        if (span) { anchor = { x: span[0], y: data.y }; head = { x: span[1], y: data.y }; dragging = false; screen.render(); finish(); return; }
      }
      if (last.count >= 3) { anchor = { x: pane.rect.x0, y: data.y }; head = { x: pane.rect.x1, y: data.y }; dragging = false; screen.render(); finish(); return; }
      anchor = { x: data.x, y: data.y }; head = null; return;
    }
    if (data.action === 'mouseup' && dragging) {
      dragging = false;
      if (!moved) { anchor = null; return; }
      // A drag is not a click: the element under the release does nothing.
      data.action = 'mouseselect'; screen.mouseDown = null; finish();
    }
  });
  // Any key ends the highlight, but for Ctrl-C: the app copies the highlight on it.
  screen.program.on('keypress', (ch, key) => { if (key?.full !== 'C-c') clear(); });
  screen.on('resize', () => clear());
  return { clear, text, range, get active() { return Boolean(anchor && head); } };
}
