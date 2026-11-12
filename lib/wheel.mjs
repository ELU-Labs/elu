// The mouse wheel, as in a browser: the content follows the fingers. A terminal reports the
// wheel as steps, not distances. Ghostty (and the terminals built on it) sends one step for
// each cell row a trackpad moves and three for a wheel notch (its mouse-scroll-multiplier),
// so a step here moves a text pane one line and a list one row, and no step is dropped: a
// slow stroke moves a line at a time, a flick moves far, a notch moves three. A turn the
// other way moves at once. blessed's own handlers, which scrolled a text pane half its height
// and moved a list two rows a step, are replaced; with a trackpad they jumped a screen or more.
// Every step moves at once and only the drawing waits: the screen is drawn at most once a
// frame, so a fast burst costs a draw a frame, not one a step. Keys are not touched.
export const WHEEL_FRAME_MS = 16;

// Runs at once on the next turn of the event loop, or after ms. The handles do not keep the
// process alive.
const soon = (run, ms) => (ms > 0 ? setTimeout(run, ms) : setImmediate(run)).unref?.();

// render, wrapped to run at most once a frame. A call after a quiet spell draws on the next
// turn of the event loop, after the rest of the read that brought it; calls within a frame of
// the last draw become one draw at the end of that frame. now and later: a test's clock.
export function frameRender(render, { frame = WHEEL_FRAME_MS, now = () => Date.now(), later = soon } = {}) {
  let last = -Infinity, waiting = false;
  const run = () => { waiting = false; last = now(); render(); };
  return () => {
    if (waiting) return;
    waiting = true; later(run, Math.max(0, last + frame - now()));
  };
}

// widget: a blessed list or scrollable box, just made. move(step), when given, moves it one
// line (-1 up, 1 down); otherwise a list moves its cursor one row, which keeps the cursor in
// view, and a box scrolls one line. render draws the result (the screen by default), at most
// once a frame. blessed's own wheel handlers on the widget are replaced. Returns the widget.
export function steadyWheel(widget, move = null, { render = () => widget.screen?.render(), ...time } = {}) {
  const list = Array.isArray(widget.items) && typeof widget.select === 'function', draw = frameRender(render, time);
  for (const name of ['wheelup', 'wheeldown', 'element wheelup', 'element wheeldown']) widget.removeAllListeners(name);
  const go = step => {
    if (move) move(step);
    else if (list) { if (widget.items.length) widget.select(Math.max(0, Math.min(widget.items.length - 1, (widget.selected ?? 0) + step))); }
    else widget.scroll(step);
    draw();
  };
  // A list hears the wheel over any of its rows as well as over itself.
  const [up, down] = list ? ['element wheelup', 'element wheeldown'] : ['wheelup', 'wheeldown'];
  widget.on(up, () => go(-1)); widget.on(down, () => go(1));
  return widget;
}
