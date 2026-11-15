import { StringDecoder } from 'node:string_decoder';

// Bracketed paste. Asked for it, the terminal wraps pasted text in ESC[200~ … ESC[201~.
// blessed does not know the markers: it would type the paste one key at a time, drawing the
// screen after each one, and a newline would submit the message half way through. Here the
// paste is taken out of the input before blessed reads keys from it and handed over whole.

const START = '\x1b[200~', END = '\x1b[201~';
const CONTROL = /[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g;

// Where a trailing start of marker begins, or the text length when there is none. Outside a
// paste a lone escape is the Escape key, so only two or more characters are held back.
function partial(text, marker, least) {
  for (let size = Math.min(marker.length - 1, text.length); size >= least; size--) if (text.endsWith(marker.slice(0, size))) return text.length - size;
  return text.length;
}

// Pasted text as typed text: newlines of any kind, tabs, and no other control characters.
export const pastedText = text => text.replace(/\r\n?/g, '\n').replace(CONTROL, '');

// Splits a stream of input into keys for blessed and pastes for onPaste. Chunks may cut a
// marker or a character anywhere.
export function pasteSplitter(onKeys, onPaste) {
  const decoder = new StringDecoder('utf8');
  let held = '', pasting = false, pasted = '';
  return chunk => {
    let text = held + (typeof chunk === 'string' ? chunk : decoder.write(chunk)); held = '';
    while (text) {
      if (pasting) {
        const end = text.indexOf(END);
        if (end < 0) { const cut = partial(text, END, 1); pasted += text.slice(0, cut); held = text.slice(cut); return; }
        pasted += text.slice(0, end); text = text.slice(end + END.length); pasting = false;
        const value = pasted; pasted = ''; onPaste(value);
        continue;
      }
      const start = text.indexOf(START);
      if (start < 0) { const cut = partial(text, START, 2); if (cut) onKeys(text.slice(0, cut)); held = text.slice(cut); return; }
      if (start) onKeys(text.slice(0, start));
      text = text.slice(start + START.length); pasting = true;
    }
  };
}

// Esc and the key typed right after it can come in one read: tmux sends them so when the key
// comes within its escape-time, and a slow connection may too. blessed reads Esc before a
// letter or a digit as Alt and that key, and drops both before any other character, so Esc
// then /chats lost the Esc and the /, and "chats" went in as a message. Such a pair is handed
// over as two keys. [ and O begin a terminal's key codes, and stay as they are.
export const escapeApart = text => text.split(/(?<=\x1b)(?=[^\x00-\x20\x7f\x1b[a-zA-Z0-9])/u);

// Hands keys to onKeys and pastes to onPaste in the order they came. What follows an Esc set
// apart (escapeApart) is handed over a turn later (later), once the Esc has acted: a dialog it
// closes gives the focus back on that turn, and before it the keys reached no box or list.
// Input that comes meanwhile waits behind them.
export function keyQueue(onKeys, onPaste, later = setImmediate) {
  const queue = []; let waiting = false;
  const drain = () => {
    while (queue.length && !waiting) {
      const [paste, text] = queue.shift();
      if (paste) { onPaste(text); continue; }
      onKeys(text);
      if (text.endsWith('\x1b') && queue.length) { waiting = true; later(() => { waiting = false; drain(); }); }
    }
  };
  return {
    keys: text => { for (const part of escapeApart(text)) queue.push([false, part]); drain(); },
    paste: text => { queue.push([true, text]); drain(); },
  };
}

// Turns bracketed paste on for the screen's terminal and routes each paste to onPaste, until
// the screen is destroyed.
export function attachPaste(screen, onPaste) {
  const { program } = screen, input = program.input;
  // blessed's key reader on the input, from keys.emitKeypressEvents.
  const reader = input.listeners('data').find(fn => fn.name === 'onData');
  if (!reader) return;
  const feed = keyQueue(text => reader(Buffer.from(text)), onPaste);
  const split = pasteSplitter(feed.keys, feed.paste);
  input.removeListener('data', reader); input.on('data', split);
  program._write('\x1b[?2004h');
  const destroy = screen.destroy.bind(screen);
  screen.destroy = function() { program._write('\x1b[?2004l'); return destroy(); };
}
