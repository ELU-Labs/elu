import { cropRows, png } from './chart-picture.mjs';

// Pictures inside the terminal, where it can show them: a chart on the Artifacts tab is then a
// real picture (lib/chart-picture.mjs) and not text. Four parts, each used by the next:
//
// 1. Asking. TERM says nothing true over SSH, so ELU asks the terminal itself, once, as it
//    opens. First who it is, in codes every terminal reads to their end (askWho). Only a
//    terminal that names itself, and is not tmux or screen, is then asked for the Kitty
//    graphics protocol: that question is an APC string, which a terminal that answers nothing
//    may print as text, and which tmux takes as its pane's title. Kitty, Ghostty and the apps
//    built on it and WezTerm answer OK. iTerm2 names itself and gets its own inline-image
//    protocol. No answer in time, a no, tmux or screen: text, and nothing more is written.
// 2. The answers come in with the keys: replySplitter takes them out before a key is read.
// 3. Placing. The screen is blessed's grid of cells, one character and 256 colours each, so it
//    cannot carry Kitty's Unicode placeholders (a character beyond its tables with two marks on
//    it, coloured by the picture's number), and WezTerm draws none. So a picture is placed by
//    its number at a cell, and removed by its number (pictureLayer): the same book-keeping
//    iTerm2 needs, whose pictures are part of the cells and go when the cells are written.
// 4. The screen. attachPictures places after each frame what the frame left room for: the
//    cells a picture covers hold PICTURE_CELL, and a picture is shown only while every one of
//    them still does, so a dialog or another tab over any of them takes it away.
//
// ELU_NO_PICTURES=1 turns pictures off. ELU_PICTURES=kitty or iterm uses that protocol without
// asking for it: for a test, or a terminal that does not say who it is and shows them all the
// same. Inside tmux or screen it changes nothing: they show no picture, and a terminal that says
// it is one of them is sent none.

// A cell under a picture: blank, one column wide in every terminal, and nothing else is drawn with it.
export const PICTURE_CELL = '\u00a0';
// A cell's size in pixels where the terminal does not say, and the most a picture is drawn at.
export const DEFAULT_CELL = Object.freeze({ width: 12, height: 24 });
const MOST_CELL = 48;

export function pictureSwitch(env = process.env) {
  if (env.ELU_NO_PICTURES && env.ELU_NO_PICTURES !== '0') return 'off';
  // Inside tmux or screen the terminal itself is out of reach, whatever ELU is told.
  if (env.TMUX || env.STY || /^(?:screen|tmux)/.test(env.TERM ?? '')) return 'off';
  const forced = String(env.ELU_PICTURES ?? '').toLowerCase();
  if (forced === 'kitty' || forced === 'iterm') return forced;
  return env.TERM === 'dumb' ? 'off' : 'ask';
}

// What ELU writes to ask. Who: XTVERSION, iTerm2's own version report, and the device
// attributes every terminal answers, so the wait ends with it. Then Kitty's query (a picture
// of one pixel that is not kept), the size of a cell and of the window in pixels, and the
// device attributes again.
export const ASK_WHO = '\x1b[>0q\x1b[1337n\x1b[c';
export const ASK_KITTY = '\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\';
export const ASK_SIZE = '\x1b[16t\x1b[14t';
export const ASK_END = '\x1b[c';

// Kitty: the PNG kept under a number, in pieces of 4096 characters; shown at a cell as placement
// 1, scaled to cols by rows cells from the part of it that crop names (a second placement of the
// same numbers moves the first); its placement removed; the picture itself removed. q=2: the
// terminal answers none of them.
export function kittySend(id, data) {
  const text = data.toString('base64'), parts = [];
  for (let at = 0; at < text.length; at += 4096) parts.push(`\x1b_G${at ? '' : `a=t,f=100,t=d,i=${id},`}q=2,m=${at + 4096 < text.length ? 1 : 0};${text.slice(at, at + 4096)}\x1b\\`);
  return parts.join('');
}
export const kittyPlace = (id, { row, col, cols, rows, crop }) => `\x1b7\x1b[${row + 1};${col + 1}H\x1b_Ga=p,i=${id},p=1,c=${cols},r=${rows},x=${crop.x},y=${crop.y},w=${crop.width},h=${crop.height},C=1,q=2\x1b\\\x1b8`;
export const kittyHide = id => `\x1b_Ga=d,d=i,i=${id},p=1,q=2\x1b\\`;
export const kittyDrop = id => `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;
// iTerm2: the PNG drawn at a cell over cols by rows cells. It is part of those cells from then on.
export const itermDraw = (data, { row, col, cols, rows }) => `\x1b7\x1b[${row + 1};${col + 1}H\x1b]1337;File=inline=1;size=${data.length};width=${cols};height=${rows};preserveAspectRatio=0:${data.toString('base64')}\x07\x1b8`;

// A terminal's answers, as they come in with the keys. None of them is a key. iTerm2's version
// may hold an n: its report ends where the next answer starts, or the input does.
const ANSWERS = /\x1bP>\|([^\x1b\x07]*)(?:\x1b\\|\x07)|\x1b_G([^\x1b\x07]*)(?:\x1b\\|\x07)|\x1b\[\?([\d;]*)c|\x1b\[([46]);(\d+);(\d+)t|\x1b\[ITERM2 ([^\x1b\x07]*)n(?=\x1b|$)/g;
// The start of an answer that the end of a read cut off: Esc alone too, while one is asked for.
const CUT = /\x1b(?:P(?:>(?:\|[^\x1b\x07]*\x1b?)?)?|_(?:G[^\x1b\x07]*\x1b?)?|\[(?:\?[\d;]*|[46](?:;\d*(?:;\d*)?)?|I(?:T[^\x1b\x07]*)?)?)?$/;
// A cut start that no key begins with: it is an answer, whatever follows.
const SURE = /^\x1b(?:P>\||_G|\[\?|\[IT)/;
function answerOf(found) {
  const [, version, kitty, attributes, size, high, wide, iterm] = found;
  if (version !== undefined) return { kind: 'version', text: version };
  if (kitty !== undefined) return { kind: 'kitty', text: kitty };
  if (attributes !== undefined) return { kind: 'attributes', text: attributes };
  if (size !== undefined) return { kind: size === '6' ? 'cell' : 'window', height: Number(high), width: Number(wide) };
  return { kind: 'iterm', text: iterm };
}

// Splits each read of input into the keys and the terminal's answers. An answer cut by the end
// of a read waits for the rest of it; asked(): whether an answer is expected now, so that two
// characters which may start one (Alt and [, say) wait too. take(chunk) gives { keys, answers },
// the keys as the bytes between the answers; rest() gives up what still waits, once no more came.
export function replySplitter({ asked = () => false } = {}) {
  let held = Buffer.alloc(0);
  const split = (data, last) => {
    const text = data.toString('latin1'), keys = [], answers = [];
    let at = 0;
    const key = to => { if (to > at) keys.push(data.subarray(at, to)); };
    for (const found of text.matchAll(ANSWERS)) {
      // iTerm2's report at the very end of a read may not be whole yet.
      if (found[7] !== undefined && found.index + found[0].length === text.length && !last) break;
      key(found.index); answers.push(answerOf(found)); at = found.index + found[0].length;
    }
    const cut = last ? -1 : text.slice(at).search(CUT);
    // Esc, Esc with one more character, and the report that the window has the focus may be all
    // that was typed: they wait only while an answer is asked for.
    if (cut >= 0) { const tail = text.slice(at + cut); if (tail.length > 2 && tail !== '\x1b[I' || asked()) { key(at + cut); held = Buffer.from(data.subarray(at + cut)); return { keys, answers }; } }
    // What waited and never ended: an answer's start is dropped, anything else was typed.
    if (last && SURE.test(text.slice(at))) return { keys, answers };
    key(text.length);
    return { keys, answers };
  };
  return {
    take(chunk) { const fresh = typeof chunk === 'string' ? Buffer.from(chunk) : chunk, data = held.length ? Buffer.concat([held, fresh]) : fresh; held = Buffer.alloc(0); return split(data, false); },
    rest() { const data = held; held = Buffer.alloc(0); return data.length ? split(data, true) : { keys: [], answers: [] }; },
    get waiting() { return held.length > 0; },
  };
}

// Asks the terminal, and keeps what it said. write(text): to the terminal. size(): its columns
// and rows now. onChange(): the protocol or the size of a cell is known, or changed.
// protocol is null until the terminal has answered, then 'kitty', 'iterm' or 'off'.
export function pictureAsker({ write, env = process.env, wait = 1500, size = () => ({ columns: 80, rows: 24 }), onChange = () => {}, timers = { set: setTimeout, clear: clearTimeout }, later = setImmediate } = {}) {
  const mode = pictureSwitch(env), told = mode === 'kitty' || mode === 'iterm' ? mode : null;
  let protocol = mode === 'off' ? 'off' : null, stage = 'idle', name = '', iterm = false, kitty = false, timer = null, asks = 0, sizeBy = 0, sizeTimer = null, pending = false, cell = null, window = null;
  const settle = value => { timers.clear(timer); timer = null; stage = 'done'; protocol = value; onChange(); };
  // A timer that is late because the app was busy fires before the answers that waited with it
  // are read: they are read first, and may have asked the next question, which waits by itself.
  // No answer in time: text, or the protocol ELU was told, for a terminal that answers nothing.
  const timed = () => { const mine = ++asks; timer = timers.set(() => later(() => { if (mine !== asks || stage !== 'who' && stage !== 'kitty') return; if (stage === 'who' && told) taken(); else settle('off'); }), wait); timer?.unref?.(); };
  // The size of a cell is asked for: its answer is expected for as long as the wait. hold: no
  // picture is drawn until it came or the wait is over, so none is drawn at a size that is
  // about to change.
  const sized = (hold = true) => {
    sizeBy = Date.now() + wait;
    if (hold) {
      pending = true; timers.clear(sizeTimer);
      sizeTimer = timers.set(() => later(() => { if (!pending) return; pending = false; if (stage === 'done' && protocol !== 'off') onChange(); }), wait); sizeTimer?.unref?.();
    }
    write(ASK_SIZE);
  };
  // Told which protocol to use: it is not asked for, and its pictures do not wait for a size
  // the terminal may never say.
  const taken = () => { sized(false); settle(told); };
  const shown = () => {
    const from = cell ?? (window ? { width: Math.floor(window.width / Math.max(1, size().columns)), height: Math.floor(window.height / Math.max(1, size().rows)) } : null);
    if (!from || !(from.width >= 4 && from.height >= 6)) return { ...DEFAULT_CELL };
    // iTerm2 counts in points, two pixels each on today's screens.
    const twice = protocol === 'iterm' ? 2 : 1, scale = Math.min(1, MOST_CELL / (from.height * twice)) * twice;
    return { width: Math.max(4, Math.round(from.width * scale)), height: Math.max(6, Math.round(from.height * scale)) };
  };
  return {
    get protocol() { return protocol; },
    get asking() { return stage === 'who' || stage === 'kitty' || Date.now() < sizeBy; },
    get name() { return name; },
    get cell() { return shown(); },
    // Whether the size of a cell is settled: said by the terminal, or not coming.
    get sized() { return !pending; },
    start() {
      if (stage !== 'idle') return;
      if (protocol === 'off') { stage = 'done'; return; }
      // The wait starts before the question: an answer may come while it is written.
      stage = 'who'; timed(); write(ASK_WHO);
    },
    // The window changed: its cells may have another size.
    resized() { if (protocol === 'kitty' || protocol === 'iterm') sized(); },
    answer(found) {
      if (found.kind === 'cell' || found.kind === 'window') {
        if (!(found.width > 0 && found.height > 0)) return;
        const before = JSON.stringify(shown()), waited = pending;
        if (found.kind === 'cell') cell = { width: found.width, height: found.height }; else window = { width: found.width, height: found.height };
        pending = false; timers.clear(sizeTimer);
        if (stage === 'done' && protocol !== 'off' && (waited || JSON.stringify(shown()) !== before)) onChange();
        return;
      }
      if (found.kind === 'version') { if (stage === 'who') name = found.text.trim(); return; }
      if (found.kind === 'iterm') { if (stage === 'who') iterm = true; return; }
      if (found.kind === 'kitty') { if (stage === 'kitty' && /^i=31(?:,[^;]*)?;OK$/.test(found.text)) kitty = true; return; }
      if (found.kind !== 'attributes') return;
      if (stage === 'who') {
        timers.clear(timer);
        if (/^(?:tmux|screen)\b/i.test(name)) return settle('off');
        if (told) return taken();
        // iTerm2 gets its own protocol, whatever else it may answer.
        if (iterm || /^iterm2\b/i.test(name)) { sized(); return settle('iterm'); }
        if (!name) return settle('off');
        stage = 'kitty'; timed(); write(`${ASK_KITTY}${ASK_SIZE}${ASK_END}`);
        return;
      }
      if (stage === 'kitty') settle(kitty ? 'kitty' : /^wezterm\b/i.test(name) ? 'iterm' : 'off');
    },
    stop() { timers.clear(timer); timers.clear(sizeTimer); timer = sizeTimer = null; pending = false; if (stage !== 'done') { stage = 'done'; protocol ??= 'off'; } },
  };
}

// What the terminal holds of ELU's pictures, and what to write to change it. A picture is
// { key, draw }: key names its content and size, draw() gives { width, height, rgba }. A place is
// a picture with where it shows: row and col on the screen, cols by rows cells, skip rows of it
// cut from its top and of rows in all.
// Kitty: a picture is sent once and kept by the terminal under a number; showing, moving and
// cutting it are a few bytes each, and hiding it keeps it there for the next time. The most
// lately shown few are kept. iTerm2: a picture is sent each time it shows or moves, cut to what
// shows; the cells it was in are written again by the screen first (settle says which).
export function pictureLayer({ write, protocol, firstId = 1 + Math.floor(Math.random() * 0x7fffff) * 256, kept = 8 }) {
  const known = new Map(), shown = new Map();
  let next = 0;
  const signature = place => [place.row, place.col, place.cols, place.rows, place.skip, place.of].join();
  const rect = place => ({ row: place.row, col: place.col, cols: place.cols, rows: place.rows });
  return {
    get count() { return shown.size; },
    get ids() { return [...known.values()].map(entry => entry.id); },
    // Before the screen is drawn: the cells of pictures that will go or move, which it must
    // write again. touched(rect): whether it is about to write any of those cells itself.
    settle(places, touched = () => false) {
      if (protocol !== 'iterm') return [];
      const spoiled = [];
      for (const [key, was] of shown) {
        const now = places.find(place => place.key === key);
        if (!now || signature(now) !== was.signature || touched(was.rect)) { spoiled.push(was.rect); shown.delete(key); }
      }
      return spoiled;
    },
    // After it is drawn: every place shows its picture, and no other picture shows.
    sync(places) {
      let out = '';
      if (protocol === 'iterm') {
        for (const place of places) {
          if (shown.has(place.key)) continue;
          let entry = known.get(place.key);
          if (!entry) { entry = { picture: place.draw() }; known.set(place.key, entry); }
          known.delete(place.key); known.set(place.key, entry);
          const picture = entry.picture, part = place.skip || place.rows !== place.of ? cropRows(picture, place.skip, place.rows, Math.round(picture.height / place.of)) : picture;
          out += itermDraw(png(part), place);
          shown.set(place.key, { signature: signature(place), rect: rect(place) });
        }
        for (const key of [...known.keys()]) { if (known.size <= kept) break; if (!shown.has(key)) known.delete(key); }
      } else {
        for (const [key] of shown) if (!places.some(place => place.key === key)) { out += kittyHide(known.get(key).id); shown.delete(key); }
        for (const place of places) {
          let entry = known.get(place.key);
          if (!entry) {
            const picture = place.draw();
            entry = { id: (firstId + next++) >>> 0 || 1, width: picture.width, height: picture.height };
            out += kittySend(entry.id, png(picture));
          }
          known.delete(place.key); known.set(place.key, entry);
          if (shown.get(place.key)?.signature === signature(place)) continue;
          const rowHeight = Math.round(entry.height / place.of);
          out += kittyPlace(entry.id, { ...place, crop: { x: 0, y: place.skip * rowHeight, width: entry.width, height: place.rows * rowHeight } });
          shown.set(place.key, { signature: signature(place), rect: rect(place) });
        }
        for (const [key, entry] of [...known]) { if (known.size <= kept) break; if (!shown.has(key)) { out += kittyDrop(entry.id); known.delete(key); } }
      }
      if (out) write(out);
      return out;
    },
    // The terminal clears its screen, or ELU leaves: no picture shows any more, and none that
    // ELU sent is kept.
    forget() {
      let out = '';
      if (protocol !== 'iterm') for (const entry of known.values()) out += kittyDrop(entry.id);
      known.clear(); shown.clear();
      if (out) write(out);
      return out;
    },
  };
}

// The part of a picture of rows rows, the first of them at row of a pane's text, that shows in
// the high rows of it in view: { first, rows, skip }, or null when none of it does.
export function inView(row, rows, high) {
  const first = Math.max(0, row), last = Math.min(high, row + rows);
  return last > first ? { first, rows: last - first, skip: first - row } : null;
}

// Passes every read of the screen's input through replySplitter, to all that listen to it, the
// answers to onAnswer. Call it once blessed's readers and the app's own are attached. What it
// returns gives the input back to them as it was.
export function attachReplies(screen, onAnswer, { asked = () => false, hold = 80 } = {}) {
  const input = screen.program.input, readers = input.listeners('data');
  if (!readers.length) return () => {};
  const splitter = replySplitter({ asked });
  let timer = null;
  const pass = ({ keys, answers }) => { for (const found of answers) onAnswer(found); for (const part of keys) for (const reader of readers) reader.call(input, part); };
  const each = chunk => {
    clearTimeout(timer); pass(splitter.take(chunk));
    if (splitter.waiting) { timer = setTimeout(() => pass(splitter.rest()), hold); timer.unref?.(); }
  };
  for (const reader of readers) input.removeListener('data', reader);
  input.on('data', each);
  let attached = true;
  return () => { if (!attached) return; attached = false; clearTimeout(timer); input.removeListener('data', each); for (const reader of readers) input.on('data', reader); };
}

// Pictures on a blessed screen. show({ box, left, top, high, pictures }) says what the frame
// being drawn has room for: pictures in box, whose text starts left columns and top rows inside
// it and shows high rows, each { key, draw, row, col, cols, rows } by the row of that text it
// starts at (below 0: scrolled past the top). They are placed after the frame is written, the
// ones whose cells all still hold PICTURE_CELL. cell is the size of a cell in pixels while
// pictures can be shown, else null: the caller then draws text.
export function attachPictures(screen, { env = process.env, wait, firstId, onChange = () => {}, settleMs = 250 } = {}) {
  const program = screen.program;
  let layer = null, request = null, settling = null, closed = false;
  const write = text => { program._write(text); };
  // A screen that cannot write PICTURE_CELL as it is (no UTF-8) shows none.
  const ready = () => { if (!layer && !closed && (asker.protocol === 'kitty' || asker.protocol === 'iterm') && screen._unicode !== false) layer = pictureLayer({ write, protocol: asker.protocol, firstId }); };
  const changed = () => { if (closed) return; ready(); onChange(); };
  const asker = pictureAsker({ write: text => { program._write(text); program.flush(); }, env, wait, size: () => ({ columns: screen.width, rows: screen.height }), onChange: changed });
  const detach = attachReplies(screen, found => asker.answer(found), { asked: () => asker.asking });
  const cellAt = (lines, y, x) => lines[y]?.[x];
  const intact = ({ row, col, cols, rows }) => { for (let y = row; y < row + rows; y++) for (let x = col; x < col + cols; x++) if (cellAt(screen.lines, y, x)?.[1] !== PICTURE_CELL) return false; return true; };
  const touched = ({ row, col, cols, rows }) => { for (let y = row; y < row + rows; y++) for (let x = col; x < col + cols; x++) { const now = cellAt(screen.lines, y, x), was = cellAt(screen.olines, y, x); if (!now || !was || now[0] !== was[0] || now[1] !== was[1]) return true; } return false; };
  // The screen writes these cells again on this frame, whatever it thinks they hold.
  const spoil = ({ row, col, cols, rows }) => { for (let y = row; y < row + rows; y++) { const was = screen.olines[y]; if (!was) continue; for (let x = col; x < col + cols; x++) if (was[x]) was[x][1] = ''; if (screen.lines[y]) screen.lines[y].dirty = true; } };
  function places() {
    const pos = request?.box.lpos;
    if (!request || !pos || request.box.hidden || settling) return [];
    const out = [];
    for (const picture of request.pictures) {
      const part = inView(picture.row, picture.rows, request.high);
      if (!part) continue;
      // Never the last row of the screen: a terminal may scroll after a picture there.
      const row = pos.yi + request.top + part.first, rows = Math.min(part.rows, screen.height - 1 - row), place = { key: picture.key, draw: picture.draw, row, col: pos.xi + request.left + picture.col, cols: picture.cols, rows, skip: part.skip, of: picture.rows };
      if (rows > 0 && intact(place)) out.push(place);
    }
    return out;
  }
  const draw = screen.draw, alloc = screen.alloc, leave = screen.leave, clean = screen.cleanSides, destroy = screen.destroy;
  screen.draw = function (start, end) {
    const whole = layer && start === 0 && end >= this.lines.length - 1, list = whole ? places() : null;
    if (whole) for (const rect of layer.settle(list, touched)) spoil(rect);
    const result = draw.call(this, start, end);
    if (whole) layer.sync(list);
    return result;
  };
  // A cleared screen holds no picture: each is sent again where it still shows.
  screen.alloc = function (dirty) { layer?.forget(); return alloc.call(this, dirty); };
  // A terminal that scrolls part of its screen takes a picture there with it: while one shows,
  // the screen writes the rows that moved instead.
  screen.cleanSides = function (el) { return layer?.count ? false : clean.call(this, el); };
  const close = () => { if (closed) return; closed = true; clearTimeout(settling); asker.stop(); try { layer?.forget(); program.flush(); } catch { /* A terminal that is gone holds nothing. */ } layer = null; };
  screen.leave = function () { close(); return leave.call(this); };
  screen.destroy = function () { close(); detach(); return destroy.call(this); };
  // The window has a new size: its cells may have one too, so the terminal is asked again, and
  // the text shows until it had the time to answer. Heard before the screen clears and draws for
  // the new size, so that frame is text already.
  program.prependListener('resize', () => { if (closed || !layer) return; clearTimeout(settling); asker.resized(); settling = setTimeout(() => { settling = null; onChange(); }, settleMs); settling.unref?.(); });
  asker.start(); ready();
  return {
    get protocol() { return asker.protocol; },
    // What the terminal calls itself, or '' when it did not say.
    get name() { return asker.name; },
    get cell() { return layer && !settling && !closed && asker.sized ? asker.cell : null; },
    show(value) { request = value; },
  };
}
