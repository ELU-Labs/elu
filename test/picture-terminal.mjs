import zlib from 'node:zlib';
import { terminalModel } from './terminal-model.mjs';

// A PNG read back, by node's zlib alone: its size and the colour of a pixel, [r, g, b, alpha].
// It takes what lib/chart-picture.mjs writes (eight bits a channel with alpha) and checks every
// chunk's checksum with zlib's own.
export function readPng(data) {
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Not a PNG.');
  let at = 8, width = 0, height = 0; const parts = [], kinds = [];
  while (at < data.length) {
    const size = data.readUInt32BE(at), kind = data.toString('latin1', at + 4, at + 8), body = data.subarray(at + 8, at + 8 + size);
    if (data.readUInt32BE(at + 8 + size) !== zlib.crc32(data.subarray(at + 4, at + 8 + size))) throw new Error(`The ${kind} chunk's checksum is wrong.`);
    kinds.push(kind);
    if (kind === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); if (body[8] !== 8 || body[9] !== 6 || body[10] || body[11] || body[12]) throw new Error('Not eight bits a channel with alpha.'); }
    if (kind === 'IDAT') parts.push(body);
    at += 12 + size;
  }
  if (kinds[0] !== 'IHDR' || kinds.at(-1) !== 'IEND') throw new Error(`Chunks out of order: ${kinds.join(' ')}`);
  const raw = zlib.inflateSync(Buffer.concat(parts)), stride = width * 4 + 1;
  if (raw.length !== stride * height) throw new Error(`${raw.length} bytes of pixels for ${width} by ${height}.`);
  for (let y = 0; y < height; y++) if (raw[y * stride] !== 0) throw new Error(`Row ${y} is filtered.`);
  return { width, height, at: (x, y) => [...raw.subarray(y * stride + 1 + x * 4, y * stride + 5 + x * 4)] };
}

// What each stand-in says of itself. name: its XTVERSION answer. own: iTerm2's version report.
// graphics: 'kitty' answers Kitty's query with OK, 'no' with an error. inline: it draws iTerm2's
// inline pictures. apc: false prints an APC string as text, as a terminal that does not know
// them may. sizes: false says no size of a cell or of the window. silent: it answers nothing at all.
const KINDS = {
  kitty: { name: 'kitty(0.36.4)', graphics: 'kitty', attributes: '62;' },
  ghostty: { name: 'ghostty 1.2.0', graphics: 'kitty', attributes: '62;22' },
  wezterm: { name: 'WezTerm 20240203-110809-5046fc22', graphics: 'kitty', inline: true, attributes: '65;4;6;18;22' },
  'wezterm-inline': { name: 'WezTerm 20240203-110809-5046fc22', inline: true, attributes: '65;4;6;18;22' },
  iterm: { name: 'iTerm2 3.5.11', own: '3.5.11', inline: true, attributes: '1;2' },
  'iterm-old': { own: '3.3.12-nightly', inline: true, attributes: '1;2' },
  'iterm-no-size': { name: 'iTerm2 3.5.11', own: '3.5.11', inline: true, attributes: '1;2', sizes: false },
  xterm: { name: 'XTerm(390)', attributes: '64;1;2;6;9;15;16;17;18;21;22;28' },
  refuses: { name: 'kitty(0.36.4)', graphics: 'no', attributes: '62;' },
  plain: { attributes: '1;2', apc: false, sizes: false },
  tmux: { name: 'tmux 3.4', attributes: '1;2', apc: false, sizes: false },
  silent: { silent: true, apc: false, sizes: false },
};
// A cell that holds part of an inline picture: a character no app writes.
export const IMAGE = '\ue0ff';
const TOKEN = /\x1b_G([^\x1b]*)\x1b\\|\x1b\]1337;File=([^:\x07]*):([^\x07]*)\x07|\x1b\[>0q|\x1b\[1337n|\x1b\[c|\x1b\[1([46])t|\x1b\[(?:2J|\?1049[hl])/g;
// The start of a string that has not ended yet.
const OPEN = /\x1b(?:_[^\x1b]*\x1b?|\]1337;[^\x07]*|\[[\d;?>]*)?$/;

// A terminal for tests that answers what ELU asks and keeps the pictures it is sent, as the
// terminal of that kind does. read(text) takes what the app wrote and returns what the terminal
// answers. images: the Kitty pictures it holds, by number. placed: where each shows, by
// "number:placement". drawn: every inline picture it was sent, in order. text: the cells
// (test/terminal-model.mjs). inlineCells(): how many cells still show an inline picture.
export function pictureTerminal(kind = 'kitty', { columns = 80, rows = 24, cell = { width: 10, height: 20 } } = {}) {
  const says = KINDS[kind]; if (!says) throw new Error(`No stand-in terminal called ${kind}.`);
  let text = terminalModel(columns, rows), held = '', loading = null;
  const images = new Map(), placed = new Map(), drawn = [], asked = [], sent = [], printed = [], left = [];
  const size = { columns, rows, cell };
  const keys = control => Object.fromEntries(control.split(',').filter(Boolean).map(part => { const at = part.indexOf('='); return [part.slice(0, at), part.slice(at + 1)]; }));
  const unplace = (id, placement) => { for (const key of [...placed.keys()]) if (key.startsWith(`${id}:`) && (placement === undefined || key === `${id}:${placement}`)) placed.delete(key); };
  function graphics(body) {
    if (says.apc === false) { printed.push(body); return ''; }
    if (!says.graphics) return '';
    const cut = body.indexOf(';'), control = keys(cut < 0 ? body : body.slice(0, cut)), payload = cut < 0 ? '' : body.slice(cut + 1);
    const reply = (id, message) => control.q === '2' || control.q === '1' && message === 'OK' ? '' : `\x1b_Gi=${id};${message}\x1b\\`;
    if (loading) {
      loading.payload += payload;
      if (control.m === '1') return '';
      const done = loading; loading = null;
      unplace(done.id); images.set(done.id, Buffer.from(done.payload, 'base64')); sent.push(done.id);
      return '';
    }
    const action = control.a ?? 't', id = Number(control.i ?? 0);
    if (action === 'q') return says.graphics === 'kitty' ? reply(id, 'OK') : reply(id, 'ENOTSUPPORTED:no pictures here');
    if (says.graphics !== 'kitty') return '';
    if (action === 't') {
      if (control.f !== '100') return reply(id, 'EINVAL:only PNG in this stand-in');
      if (control.m === '1') { loading = { id, payload }; return ''; }
      unplace(id); images.set(id, Buffer.from(payload, 'base64')); sent.push(id);
      return reply(id, 'OK');
    }
    if (action === 'p') {
      if (!images.has(id)) { printed.push(`ENOENT ${body}`); return reply(id, 'ENOENT:no such picture'); }
      placed.set(`${id}:${control.p ?? 0}`, { id, row: text.cursor.y, col: text.cursor.x, cols: Number(control.c), rows: Number(control.r), x: Number(control.x ?? 0), y: Number(control.y ?? 0), width: Number(control.w ?? 0), height: Number(control.h ?? 0), cursorStays: control.C === '1' });
      return reply(id, 'OK');
    }
    if (action === 'd') {
      const what = control.d ?? 'a';
      if (what === 'a' || what === 'A') { placed.clear(); if (what === 'A') images.clear(); }
      else if (what === 'i' || what === 'I') { unplace(id, control.p); if (what === 'I' && ![...placed.keys()].some(key => key.startsWith(`${id}:`))) images.delete(id); }
      return '';
    }
    return '';
  }
  function inline(args, data) {
    if (!says.inline) return;
    const given = Object.fromEntries(args.split(';').map(part => part.split('='))), at = text.cursor;
    const picture = { row: at.y, col: at.x, cols: Number(given.width), rows: Number(given.height), size: Number(given.size), inline: given.inline, keepsShape: given.preserveAspectRatio, data: Buffer.from(data, 'base64') };
    drawn.push(picture);
    for (let y = picture.row; y < picture.row + picture.rows && y < size.rows; y++) for (let x = picture.col; x < picture.col + picture.cols && x < size.columns; x++) text.grid[y][x] = IMAGE;
  }
  return {
    read(value) {
      let data = held + String(value), out = ''; held = '';
      const open = data.search(OPEN); if (open >= 0 && data.length - open > 1) { held = data.slice(open); data = data.slice(0, open); }
      let at = 0;
      for (const found of data.matchAll(TOKEN)) {
        text.write(data.slice(at, found.index)); at = found.index + found[0].length;
        const [whole, apc, args, file, sized] = found;
        if (apc !== undefined) { asked.push(whole); out += graphics(apc); }
        else if (args !== undefined) inline(args, file);
        else if (whole === '\x1b[>0q') { asked.push(whole); if (says.name) out += `\x1bP>|${says.name}\x1b\\`; }
        else if (whole === '\x1b[1337n') { asked.push(whole); if (says.own) out += `\x1b[ITERM2 ${says.own}n`; }
        else if (whole === '\x1b[c') { asked.push(whole); if (!says.silent) out += `\x1b[?${says.attributes}c`; }
        else if (sized) { asked.push(whole); if (says.sizes !== false) out += sized === '6' ? `\x1b[6;${size.cell.height};${size.cell.width}t` : `\x1b[4;${size.cell.height * size.rows};${size.cell.width * size.columns}t`; }
        else {
          // The screen cleared, or the other screen: no picture shows, and one that shows nowhere is not kept.
          // left: what it still held each time the app went back to the first screen.
          if (whole === '\x1b[?1049l') left.push({ images: images.size, placed: placed.size });
          if (says.graphics === 'kitty') { placed.clear(); images.clear(); }
          text.write(whole);
        }
      }
      text.write(data.slice(at));
      return out;
    },
    resize(columnsNow, rowsNow, cellNow = size.cell) { Object.assign(size, { columns: columnsNow, rows: rowsNow, cell: cellNow }); text = terminalModel(columnsNow, rowsNow); placed.clear(); },
    get text() { return text; },
    inlineCells: () => text.grid.reduce((sum, row) => sum + row.filter(value => value === IMAGE).length, 0),
    images, placed, drawn, asked, sent, printed, left,
  };
}
