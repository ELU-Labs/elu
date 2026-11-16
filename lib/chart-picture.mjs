import zlib from 'node:zlib';

// A line chart as a picture, for a terminal that shows pictures (lib/terminal-pictures.mjs).
// ELU draws it itself, a pixel at a time, and writes the PNG with node's own zlib: no library.
// Only the plot is a picture: the lines, a mark on each point, the grid and the target. The
// axis, its values, the x labels and the legend stay terminal text around it
// (lib/terminal-artifacts.mjs), so they stay sharp and can be selected.
//
// The plot covers cols by rows cells of cell.width by cell.height pixels. A value's place is
// the same for the text beside it and for the pixels: high is the middle of the first row and
// low the middle of the last (chartRow), the first point the middle of the first column and the
// last point the middle of the last (chartColumn).

// The colour a terminal shows for one of its 256: the first sixteen as xterm has them, then
// the cube and the greys, which no theme changes.
const BASIC = [[0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229], [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]];
export function xtermRgb(index) {
  if (index >= 232) { const grey = 8 + (index - 232) * 10; return [grey, grey, grey]; }
  if (index >= 16) { const level = step => step ? 55 + step * 40 : 0, at = index - 16; return [level(Math.floor(at / 36)), level(Math.floor(at / 6) % 6), level(at % 6)]; }
  return BASIC[index] ?? BASIC[7];
}

// Where a value is, in rows from the top of the plot (0.5 is the middle of the first row), and
// where a point is, in columns from its left.
export const chartRow = (value, { low, high, rows }) => 0.5 + Math.max(0, Math.min(1, (high - value) / (high - low))) * (rows - 1);
export const chartColumn = (index, { points, cols }) => points <= 1 ? cols / 2 : 0.5 + index * (cols - 1) / (points - 1);

const CRC = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
function crc(bytes) { let c = 0xffffffff; for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
// A PNG of { width, height, rgba }: eight bits a channel with alpha, each row unfiltered.
export function png({ width, height, rgba }) {
  const stride = width * 4, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const head = Buffer.alloc(13); head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// The rows from skip on, rows of them, of a picture of rowHeight pixels a row.
export function cropRows(picture, skip, rows, rowHeight) {
  const stride = picture.width * 4, from = skip * rowHeight * stride, height = rows * rowHeight;
  return { width: picture.width, height, rgba: picture.rgba.subarray(from, from + height * stride) };
}

// How far a pixel is outside a mark of size r around its middle (below 0: inside). The marks
// are the legend's, in its order: ● ■ ◆ ▲, then the same four hollow.
function outside(shape, dx, dy, r) {
  if (shape === 0) return Math.hypot(dx, dy) - r;
  if (shape === 1) return Math.max(Math.abs(dx), Math.abs(dy)) - r * 0.88;
  if (shape === 2) return (Math.abs(dx) + Math.abs(dy) - r * 1.3) / Math.SQRT2;
  return Math.max(dy - r * 0.62, 0.866 * Math.abs(dx) - 0.5 * dy - r * 0.62);
}

// The plot as pixels. chart: { cols, rows, low, high, points, ticks, target, series }, each of
// series { values, rgb, mark }, a null value a gap. cell: { width, height } in pixels.
// ink: { grid, target } as [r, g, b, alpha]; background: [r, g, b] for a terminal that shows no
// cell colour through a picture, else the picture is clear where nothing is drawn.
export function chartPicture(chart, cell, { grid = [128, 128, 128, 0.35], target = [128, 128, 128, 0.9], background = null } = {}) {
  const width = Math.max(1, Math.round(chart.cols * cell.width)), height = Math.max(1, Math.round(chart.rows * cell.height));
  // Colour times alpha, and alpha: what is drawn later goes over what is there.
  const canvas = new Float32Array(width * height * 4), mask = new Float32Array(width * height);
  let x0 = width, x1 = -1, y0 = height, y1 = -1;
  const cover = (x, y, amount) => {
    if (amount <= 0 || x < 0 || y < 0 || x >= width || y >= height) return;
    const at = y * width + x; if (amount > mask[at]) mask[at] = Math.min(1, amount);
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  };
  // What is covered takes the colour, or is cleared (rgb null), and the cover is taken away.
  const paint = (rgb, alpha = 1) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const at = y * width + x, amount = mask[at] * alpha; if (!mask[at]) continue;
      mask[at] = 0;
      const to = at * 4, rest = 1 - amount;
      canvas[to] = canvas[to] * rest + (rgb ? rgb[0] * amount : 0); canvas[to + 1] = canvas[to + 1] * rest + (rgb ? rgb[1] * amount : 0); canvas[to + 2] = canvas[to + 2] * rest + (rgb ? rgb[2] * amount : 0);
      canvas[to + 3] = canvas[to + 3] * rest + (rgb ? amount : 0);
    }
    x0 = width; x1 = -1; y0 = height; y1 = -1;
  };
  // Whole pixels from left to right (not included), tall rows from top: a rule with sharp edges.
  const bar = (left, right, top, tall) => { for (let y = top; y < top + tall; y++) for (let x = Math.max(0, Math.round(left)); x < Math.min(width, Math.round(right)); x++) cover(x, y, 1); };
  // A line from a to b, wide pixels across with round ends: each pixel by how near its middle is.
  const line = (ax, ay, bx, by, wide) => {
    const half = wide / 2, dx = bx - ax, dy = by - ay, size = dx * dx + dy * dy, reach = half + 1;
    const near = (px, py) => { const along = size ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / size)) : 0; return half + 0.5 - Math.hypot(px - ax - along * dx, py - ay - along * dy); };
    if (Math.abs(dx) >= Math.abs(dy)) {
      const slope = dx ? dy / dx : 0, spread = reach * Math.sqrt(1 + slope * slope) + 1, left = Math.min(ax, bx), right = Math.max(ax, bx);
      for (let x = Math.max(0, Math.floor(left - reach)); x <= Math.min(width - 1, Math.ceil(right + reach)); x++) {
        const middle = ay + (Math.max(left, Math.min(right, x + 0.5)) - ax) * slope;
        for (let y = Math.max(0, Math.floor(middle - spread)); y <= Math.min(height - 1, Math.ceil(middle + spread)); y++) cover(x, y, near(x + 0.5, y + 0.5));
      }
    } else {
      const slope = dx / dy, spread = reach * Math.sqrt(1 + slope * slope) + 1, top = Math.min(ay, by), bottom = Math.max(ay, by);
      for (let y = Math.max(0, Math.floor(top - reach)); y <= Math.min(height - 1, Math.ceil(bottom + reach)); y++) {
        const middle = ax + (Math.max(top, Math.min(bottom, y + 0.5)) - ay) * slope;
        for (let x = Math.max(0, Math.floor(middle - spread)); x <= Math.min(width - 1, Math.ceil(middle + spread)); x++) cover(x, y, near(x + 0.5, y + 0.5));
      }
    }
  };
  // A mark around a point, grown by more pixels; ring: only its edge, that many pixels wide.
  const mark = (shape, cx, cy, r, more = 0, ring = 0) => {
    const reach = Math.ceil(r * 1.4 + more + 1);
    for (let y = Math.floor(cy - reach); y <= Math.ceil(cy + reach); y++) for (let x = Math.floor(cx - reach); x <= Math.ceil(cx + reach); x++) {
      const away = outside(shape, x + 0.5 - cx, y + 0.5 - cy, r) - more, inside = Math.max(0, Math.min(1, 0.5 - away));
      cover(x, y, ring ? inside - Math.max(0, Math.min(1, 0.5 - away - ring)) : inside);
    }
  };
  const xOf = index => chartColumn(index, chart) * cell.width, yOf = value => chartRow(value, chart) * cell.height;
  // Lines of 2 to 3 pixels and marks to match, by the size of a cell.
  const wide = Math.max(2, Math.min(3, cell.height / 9)), dot = Math.max(3, Math.min(7, cell.height * 0.17, cell.width * 0.45));
  // The grid: a rule of one pixel at each value the axis names.
  for (const tick of chart.ticks ?? []) bar(0, width, Math.min(height - 1, Math.floor(yOf(tick))), 1);
  paint(grid, grid[3] ?? 1);
  // The target: a dashed rule of two pixels.
  if (typeof chart.target === 'number') {
    const top = Math.max(0, Math.min(height - 2, Math.round(yOf(chart.target)) - 1)), on = Math.max(4, Math.round(cell.width * 0.6)), off = Math.max(3, Math.round(cell.width * 0.4));
    for (let x = 0; x < width; x += on + off) bar(x, x + on, top, 2);
    paint(target, target[3] ?? 1);
  }
  for (const row of chart.series) {
    for (let at = 0; at + 1 < row.values.length; at++) { const from = row.values[at], to = row.values[at + 1]; if (typeof from === 'number' && typeof to === 'number') line(xOf(at), yOf(from), xOf(at + 1), yOf(to), wide); }
    paint(row.rgb);
  }
  // The marks go over every line, each with a clear edge around it; a hollow one is clear inside.
  for (const row of chart.series) {
    const shape = (row.mark ?? 0) % 4, hollow = (row.mark ?? 0) % 8 >= 4, ring = Math.max(1.5, wide * 0.7), spots = row.values.flatMap((value, at) => typeof value === 'number' ? [[xOf(at), yOf(value)]] : []);
    for (const [x, y] of spots) mark(shape, x, y, dot, 1.5);
    paint(null);
    for (const [x, y] of spots) mark(shape, x, y, dot, 0, hollow ? ring : 0);
    paint(row.rgb);
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let at = 0; at < width * height; at++) {
    const from = at * 4, alpha = canvas[from + 3];
    if (background) { for (let c = 0; c < 3; c++) rgba[from + c] = Math.round(canvas[from + c] + background[c] * (1 - alpha)); rgba[from + 3] = 255; }
    else if (alpha > 0) { for (let c = 0; c < 3; c++) rgba[from + c] = Math.round(Math.min(255, canvas[from + c] / alpha)); rgba[from + 3] = Math.round(alpha * 255); }
  }
  return { width, height, rgba };
}
