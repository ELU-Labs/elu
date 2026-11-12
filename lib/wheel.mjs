// The mouse wheel, one line at a time. blessed scrolls a text pane by half its height for
// each wheel event and moves a list's cursor two rows, and a trackpad sends a burst of
// events for one flick, so a pane jumped a screen or more. Here one wheel event moves a text
// pane one line and a list one row, and the events of a burst that come within one frame of
// the last move count as one. A turn the other way always moves at once. Keys are not touched.
export const WHEEL_FRAME_MS = 33;

// Whether a wheel step (-1 up, 1 down) moves now. now: the clock, which a test may set.
export function wheelGate({ frame = WHEEL_FRAME_MS, now = Date.now } = {}) {
  let at = -Infinity, way = 0;
  return step => {
    const time = now();
    if (step === way && time - at < frame) return false;
    at = time; way = step; return true;
  };
}

// widget: a blessed list or scrollable box, just made. move(step), when given, moves it one
// line; otherwise a list moves its cursor one row and a box scrolls one line. blessed's own
// wheel handlers on the widget are replaced. Returns the widget.
export function steadyWheel(widget, move = null, gate = wheelGate()) {
  const list = Array.isArray(widget.items) && typeof widget.select === 'function';
  for (const name of ['wheelup', 'wheeldown', 'element wheelup', 'element wheeldown']) widget.removeAllListeners(name);
  const go = step => {
    if (!gate(step)) return;
    if (move) move(step);
    else if (list) { if (widget.items.length) widget.select(Math.max(0, Math.min(widget.items.length - 1, (widget.selected ?? 0) + step))); }
    else widget.scroll(step);
    widget.screen?.render();
  };
  // A list hears the wheel over any of its rows as well as over itself.
  const [up, down] = list ? ['element wheelup', 'element wheeldown'] : ['wheelup', 'wheeldown'];
  widget.on(up, () => go(-1)); widget.on(down, () => go(1));
  return widget;
}
