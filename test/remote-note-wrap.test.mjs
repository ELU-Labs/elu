import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import blessed from 'blessed';
import { ink, wrapText } from '../lib/terminal-visuals.mjs';
import { remoteSessions } from '../lib/terminal-remote.mjs';

// The note under a session on @devbox, in the pane beside the list as the app draws it: a box
// with a border, two columns of padding each side and a scroll bar, given rows the app wrapped
// to the pane (chatWidth in lib/terminal.mjs). blessed wraps a coloured row that fills the pane
// again at its last space: on the Mac at 150 columns "the" stood alone on a row of its own.
test('the note under a session on another computer keeps the rows it was wrapped to, at every width', () => {
  const output = new PassThrough(); output.isTTY = true; output.columns = 220; output.rows = 10; output.resume();
  const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
  const screen = blessed.screen({ input, output, terminal: 'xterm-256color', fullUnicode: true, warnings: false });
  const glue = remoteSessions({ facade: {}, peerRead: () => null, peerCommand: async () => ({}), chatMessage: ({ text }) => text, ink, colour: true });
  const plain = rows => rows.map(row => row.replace(/\x1b\[[\d;]*m/g, '').trimEnd());
  const session = by => ({ machine: 'devbox', by, remote: { machine: 'd'.repeat(64), project: 'shop', state: 'answered', entries: [] } });
  const said = {
    mine: 'Runs on @devbox in shop. Type below to write to it there. Start with @here to ask your agent here.',
    teammate: 'Runs on @devbox in shop. Type below to continue it there.',
  };
  try {
    for (const by of ['mine', 'teammate']) {
      for (let room = 20; room <= 200; room++) {
        const pane = blessed.box({ parent: screen, top: 0, left: 0, width: room + 7, height: 8, border: 'line', tags: true, scrollable: true, padding: { left: 2, right: 2 }, scrollbar: { ch: ' ' } });
        const runs = glue.parts(session(by), room).find(part => part.key.startsWith('runs')).text;
        pane.setContent(runs);
        const shown = plain(pane._clines);
        assert.equal(shown.join(' '), said[by], `the whole note at ${room}`);
        // Wrapped once, by the app: blessed leaves each row as it is.
        assert.deepEqual(shown, plain(runs.split('\n').map(row => row.replace(/\{[^}]*\}/g, ''))), `rows at ${room}`);
        assert.ok(shown.every(row => row.length < room), `no row fills the pane at ${room}`);
        pane.destroy();
      }
    }
    // The owner's case, a row that ended in a short word ("to the", now "to it"), is kept whole.
    const at = [...Array(181).keys()].map(n => n + 20).find(room => wrapText(said.mine, room)[0].endsWith('to write to it'));
    assert.ok(at, 'a width where the first row ends in "it"');
    const pane = blessed.box({ parent: screen, top: 0, left: 0, width: at + 7, height: 8, border: 'line', tags: true, scrollable: true, padding: { left: 2, right: 2 }, scrollbar: { ch: ' ' } });
    pane.setContent(glue.parts(session('mine'), at).find(part => part.key.startsWith('runs')).text);
    assert.ok(!plain(pane._clines).includes('it'), `"it" is not on a row of its own at ${at}`);
  } finally { screen.destroy(); }
});
