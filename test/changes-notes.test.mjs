import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { project, fakeClis, cli, git, keyThenEnter } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { saveTask, taskDir } from '../lib/state.mjs';
import { proposeTask, currentTask } from '../lib/plan.mjs';
import { COMMANDS } from '../lib/terminal-commands.mjs';
import { launchTerminal } from '../lib/terminal.mjs';
import { buildChanges } from '../lib/diff.mjs';
import { changeRows, lostNotes, noteKey, notesMessage, placeNotes, readNotes, saveNotes } from '../lib/changes.mjs';

// Line notes in the Changes view, driven in the terminal app: the keys and the mouse
// reports arrive as bytes, as a terminal sends them.
const OLD = 'export const price = (value) => value;', NEW = 'export const price = (value) => value * (1 + tax);', LATER = 'export const price = (value) => Math.round(value * (1 + tax));';
const file = line => `export const tax = 0.2;\n${line}\nexport const name = 'price';\n`;
async function until(check, message = 'condition', timeout = 10000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
// A project with one session that changed a line of lib/price.mjs. colour: the app draws in
// colour, as it does in a terminal.
function session(t, { colour = false } = {}) {
  const removals = [], p = project({ after: close => removals.push(close) }), fake = fakeClis(p.parent);
  const values = { ...fake.env, XDG_CONFIG_HOME: path.join(p.parent, 'personal'), NO_COLOR: '1', TERM: 'xterm-256color' }, previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values); if (colour) delete process.env.NO_COLOR;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const close of removals.reverse()) await close();
  });
  assert.equal(cli(p.root, ['init', '--yes'], fake.env).status, 0);
  fs.mkdirSync(path.join(p.root, 'lib'), { recursive: true }); fs.writeFileSync(path.join(p.root, 'lib/price.mjs'), file(OLD));
  git(p.root, ['add', '.']); git(p.root, ['commit', '-m', 'Add prices']);
  const repo = repository(p.root), base = git(p.root, ['rev-parse', 'HEAD']), worktree = path.join(repo.worktrees, '1');
  fs.mkdirSync(repo.worktrees, { recursive: true }); git(p.root, ['worktree', 'add', '-b', 'feat/task-1', worktree, base]);
  fs.writeFileSync(path.join(worktree, 'lib/price.mjs'), file(NEW));
  saveTask(repo, { id: '1', goal: 'Add tax to prices', state: 'ready', worktree, branch: 'feat/task-1', base, createdAt: new Date().toISOString(), runs: [], reviews: [], messages: [], sessions: {} });
  return { repo, worktree, notes: path.join(taskDir(repo, '1'), 'line-notes.json') };
}
// shows: text the view holds once the session's changes are read. A row's key is its letter,
// then Enter (keyThenEnter): d on the session's row opens its Changes. click: they open with
// a click on their name over the chat instead.
async function view(t, repo, { columns = 100, rows = 30, shows = OLD, click = false } = {}) {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = columns; output.rows = rows;
  output.on('data', () => {});
  let rendered, closed = false;
  const finished = launchTerminal({ repo, input, output, refreshMs: 30, startConductor: () => false, onRender: value => { rendered = value; } });
  finished.then(() => { closed = true; }, () => { closed = true; });
  await until(() => rendered, 'first render');
  keyThenEnter(input, () => rendered);
  const v = {
    input, get current() { return rendered; }, get changes() { return rendered.panels.changes; },
    lines: () => rendered.panels.changes.getText().split('\n'), flat: () => rendered.panels.changes.getText().split('\n').map(line => line.trim()).join(' '), status: () => rendered.panels.status.getText(),
    modal: title => rendered.screen.children.find(child => !child.destroyed && child.options?.label?.trim() === title),
    // A click as a terminal reports it: press, then release, in SGR form (1-based cells).
    click(x, y) { input.write(`\x1b[<0;${x + 1};${y + 1}M`); input.write(`\x1b[<0;${x + 1};${y + 1}m`); },
    // The mouse moved to a cell with no button held, as a terminal reports it.
    move(x, y) { input.write(`\x1b[<35;${x + 1};${y + 1}M`); },
    // The rows of the screen as they are drawn.
    screen() { rendered.screen.render(); return rendered.screen.lines.map(line => line.map(cell => cell[1]).join('')); },
    // The view's row that holds `text`, as a cell of the screen: its + column and its y.
    row(text) { const at = v.lines().findIndex(line => line.includes(text)); assert.notEqual(at, -1, `a row with ${text}`); return { mark: v.changes.aleft + 1, y: v.changes.atop + 1 + at }; },
    // Typed into the dialog's box key by key, then Enter.
    async type(title, text) {
      await until(() => v.modal(title)?.children.find(child => child.type === 'textbox')?.__listener, `${title} box`);
      for (const ch of text) input.write(ch);
      const box = v.modal(title).children.find(child => child.type === 'textbox'); await until(() => box.getValue().endsWith(text), 'typed');
      input.write('\r'); await until(() => !v.modal(title), `${title} closed`);
    },
    async close() {
      for (const started = Date.now(); !closed && !rendered.screen.destroyed;) {
        if (Date.now() - started > 10000) throw new Error('The view did not close.');
        rendered.panels.ask.cancel();
        for (const child of [...rendered.screen.children]) { child.dismiss?.(); child.children?.find(item => item.type === 'textbox')?.emit('cancel'); }
        // q on a tab quits; on a row or in its chat it starts a message.
        rendered.panels.tabs[0].focus(); rendered.screen.emit('keypress', 'q', { name: 'q' });
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      input.destroy(); output.destroy();
    },
  };
  t.after(() => v.close());
  // The session's row in the list, then d: its Changes.
  const board = rendered.panels.board, named = () => board.items.findIndex(item => /Add tax to prices/.test(item.getText()));
  await until(() => named() >= 0, 'the session in the list');
  board.focus(); board.select(named()); await until(() => rendered.session === '1', 'the session shown');
  if (click) { const names = rendered.panels.sessionTabs; await until(() => !names.hidden && names.width > 9, 'Chat and Changes over the chat'); v.click(names.aleft + 8, names.atop); }
  else input.write('d');
  await until(() => rendered.sessionView === 'changes' && rendered.screen.focused === rendered.panels.changes && v.lines().some(line => line.includes(shows)), 'its changes');
  return v;
}

test('Changes: a click on the + or the + key notes a line, the note stays with the session, a changed line keeps its note, and s sends them', async t => {
  const s = session(t), first = await view(t, s.repo);
  assert.match(first.flat(), /\+ beside a line notes what should change\. Notes go to the model together\./);
  // A click on the line puts the cursor there: its + shows. A click on the + asks for the note.
  const added = first.row(NEW); first.click(added.mark + 12, added.y);
  await until(() => first.lines()[added.y - first.changes.atop - 1].startsWith('+'), 'the + beside the clicked line');
  assert.match(first.current.panels.keys.getText(), /\+ note/);
  first.click(added.mark, added.y); await until(() => first.modal('Note'), 'the note dialog after a click on the +');
  assert.match(first.modal('Note').children.find(child => child.options?.scrollable).getText(), /lib\/price\.mjs, line 2/);
  await first.type('Note', 'Round it to cents');
  await until(() => first.lines().some(line => /✎ Round it to cents/.test(line)), 'the note under its line');
  assert.match(first.flat(), /1 note\. s sends it to the model\./); assert.match(first.current.panels.keys.getText(), /s send notes/);
  // Up to the removed line, then the + key.
  first.input.write('\x1b[A'); await until(() => first.lines().find(line => line.includes(OLD)).startsWith('+'), 'the cursor on the removed line');
  first.input.write('+'); await first.type('Note', 'Say why the old one went');
  await until(() => first.lines().some(line => /✎ Say why the old one went/.test(line)), 'the second note');
  assert.deepEqual(JSON.parse(fs.readFileSync(s.notes, 'utf8')).notes.map(row => [row.kind, row.note]), [['add', 'Round it to cents'], ['del', 'Say why the old one went']]);
  await first.close();

  // ELU starts again after the model changed the noted line once more.
  fs.writeFileSync(path.join(s.worktree, 'lib/price.mjs'), file(LATER));
  const again = await view(t, s.repo), shown = again.flat();
  assert.match(shown, /2 notes\. s sends them to the model together\./);
  assert.match(shown, /lib\/price\.mjs, line 2 has changed since this note\. It was: export const price = \(value\) => value \*/);
  assert.match(shown, /✎ Round it to cents/); assert.match(shown, /✎ Say why the old one went/);
  again.input.write('s'); await until(() => /Sent 2 notes to the model together\./.test(again.status()), 'the notes are sent');
  assert.equal(fs.existsSync(s.notes), false, 'sent notes are not kept');
  // The chat shows next, with the message that went.
  await until(() => again.current.sessionView === 'chat', 'the chat after the notes went');
  const chat = () => again.current.panels.chat.getText().split('\n').map(line => line.replace(/┃/g, '').trim()).filter(Boolean).join(' ');
  await until(() => /Notes on your changes\. Change what each one asks:/.test(chat()), 'the message in the chat');
  assert.match(chat(), /lib\/price\.mjs, removed line 2: export const price = \(value\) => value; Say why the old one went/);
  assert.match(chat(), /lib\/price\.mjs, line 2 as it was when I wrote this note \(it has changed since\): export const price = \(value\) => value \* \(1 \+ tax\); Round it to cents/);
});

test('Changes: the line under the mouse shows a +, and one click on that + opens its note', async t => {
  const s = session(t), v = await view(t, s.repo), at = text => v.row(text).y - v.changes.atop - 1, marked = () => v.lines().flatMap((line, index) => line.startsWith('+') ? [index] : []);
  const added = v.row(NEW), removed = v.row(OLD);
  assert.deepEqual(marked(), [], 'no + before the mouse or the cursor is on a line');
  // The mouse over the text of a line: its + shows at the start of the row. The cursor stays where it was.
  v.move(added.mark + 20, added.y); await until(() => marked().length, 'a + beside the line under the mouse');
  assert.deepEqual(marked(), [at(NEW)]); assert.ok(v.lines()[0].startsWith('▌'), 'the cursor has not moved');
  // It follows the mouse to the next line, and a row that is no line shows none.
  v.move(removed.mark + 3, removed.y); await until(() => marked()[0] === at(OLD), 'the + on the line the mouse moved to');
  assert.deepEqual(marked(), [at(OLD)]);
  const header = v.row('▾ lib/price.mjs'); v.move(header.mark + 5, header.y); await until(() => !marked().length, 'no + on a file row');
  // The mouse leaves the view: the + goes.
  v.move(added.mark + 20, added.y); await until(() => marked().length, 'the + again');
  v.move(2, v.current.panels.board.atop + 1); await until(() => !marked().length, 'no + once the mouse left the view');
  // Back on the line, one click on the + asks for the note.
  v.move(added.mark, added.y); await until(() => marked()[0] === at(NEW), 'the + under the mouse');
  v.click(added.mark, added.y); await until(() => v.modal('Note'), 'the note dialog after one click on the +');
  assert.match(v.modal('Note').children.find(child => child.options?.scrollable).getText(), /lib\/price\.mjs, line 2/);
  await v.type('Note', 'Round it to cents');
  await until(() => v.lines().some(line => /✎ Round it to cents/.test(line)), 'the note under its line');
});

test('Changes: at 80 columns in colour, under a Task that waits for approval, the row under it says the note was sent', async t => {
  const s = session(t, { colour: true });
  proposeTask(s.repo, '1', { title: 'Uppercase coupons', description: 'One file changes.', goal: 'Codes compare equal whatever their case.', objectives: ['It works'], priority: 'medium', severity: 'low' });
  const v = await view(t, s.repo, { columns: 80, rows: 24, click: true }), removed = v.row(OLD);
  v.click(removed.mark, removed.y); await v.type('Note', 'Say why this went');
  await until(() => v.lines().some(line => /✎ Say why this went/.test(line)), 'the note under its line');
  v.input.write('s'); await until(() => /Sent your note to the model\./.test(v.status()), 'the note is sent');
  // The two rows of the status as the screen draws them: what waits, cut to the row, and the message under it.
  const status = v.current.panels.status, drawn = v.screen().slice(status.atop, status.atop + status.height).map(row => row.slice(status.aleft, status.aleft + status.width).trimEnd());
  assert.deepEqual(drawn, ['? Esc, then y approve · n reject, then Enter...', '› Sent your note to the model.']);
});

test('Changes: the row of a session whose Task waits for approval names d, and d then Enter opens its Changes before the Task is approved', async t => {
  const s = session(t);
  proposeTask(s.repo, '1', { title: 'Uppercase coupons', description: 'One file changes.', goal: 'Codes compare equal whatever their case.', objectives: ['It works'], priority: 'medium', severity: 'low' });
  // view() selects the row and presses d, then Enter: the changes show, with the Task still waiting.
  const v = await view(t, s.repo, { columns: 80, rows: 24 }), keys = () => v.current.panels.keys.getText();
  assert.equal(currentTask(s.repo, '1').state, 'proposed', 'looking at the changes decided nothing');
  assert.ok(v.lines().some(line => line.includes(NEW)), 'the changed line shows');
  // Esc goes back to the row, and its key bar names d beside y and n.
  v.input.write('\x1b'); await until(() => v.current.sessionView === 'chat' && v.current.screen.focused === v.current.panels.board, 'back on the row');
  await until(() => /^y approve {2}n reject {2}d changes {2}enter open {2}letter then enter {2}tab next$/.test(keys().trim()), 'the key bar names d');
});

test('Changes: with every change gone the notes stay, the view says how to send them, and s sends them', async t => {
  const s = session(t), first = await view(t, s.repo), added = first.row(NEW);
  first.click(added.mark, added.y); await first.type('Note', 'Round it to cents');
  await until(() => first.lines().some(line => /✎ Round it to cents/.test(line)), 'the note under its line');
  await first.close();
  // The model took its change back: the file reads as it did before the session.
  fs.writeFileSync(path.join(s.worktree, 'lib/price.mjs'), file(OLD));
  const again = await view(t, s.repo, { shows: 'No changes yet.' });
  await until(() => again.lines().length >= 4, 'the note with no changes');
  const shown = again.lines().map(line => line.slice(1).trim());
  assert.deepEqual(shown.slice(0, 2), ['No changes yet.', '1 note. s sends it to the model.']);
  assert.equal(shown.slice(2).join(' '), `lib/price.mjs, line 2 has changed since this note. It was: ${NEW} ✎ Round it to cents`);
  assert.match(again.current.panels.keys.getText(), /s send notes/);
  again.input.write('s'); await until(() => /Sent your note to the model\./.test(again.status()), 'the note is sent');
  assert.equal(fs.existsSync(s.notes), false, 'a sent note is not kept');
  await until(() => again.current.sessionView === 'chat', 'the chat after the note went');
  const chat = () => again.current.panels.chat.getText().split('\n').map(line => line.replace(/┃/g, '').trim()).filter(Boolean).join(' ');
  await until(() => /lib\/price\.mjs, line 2 as it was when I wrote this note \(it has changed since\): export const price = \(value\) => value \* \(1 \+ tax\); Round it to cents/.test(chat()), 'the message in the chat');
});

test('/help says how line notes work, with /changes', async t => {
  const said = 'Show what this session changed, in place of its chat. There, + on a line (or a click on its +) notes what should change, and s sends the notes to the model together';
  assert.equal(COMMANDS.find(row => row.name === 'changes').description, said);
  const s = session(t), v = await view(t, s.repo);
  v.input.write('?'); await until(() => v.modal('Commands'), 'the commands');
  assert.ok(v.modal('Commands').children.find(child => child.options?.scrollable).getText().replace(/\s+/g, ' ').includes(`/changes ${said}`));
});

const PATCH = (from, to) => ['diff --git a/src/a.mjs b/src/a.mjs', 'index 1111111..2222222 100644', '--- a/src/a.mjs', '+++ b/src/a.mjs', '@@ -1,3 +1,3 @@', ...from.map(line => `-${line}`), ...to.map(line => `+${line}`), ' same', ''].join('\n');
const built = (from, to) => buildChanges({ base: 'a1b2c3d4'.repeat(5), branch: 'feat/task-3', patch: PATCH(from, to), untracked: [], read: () => null });
const lineOf = (changes, text) => changeRows(changes, 100, false, { notes: new Map() }).find(row => row.line?.text === text).line;

test('a note follows a line that only moved, and one whose line changed is shown and sent with the line as it was', () => {
  const before = built(['one'], ['two', 'three']), two = lineOf(before, 'two'), three = lineOf(before, 'three');
  const notes = new Map([[noteKey(two), { ...two, note: 'About two' }], [noteKey(three), { ...three, note: 'About three' }]]);
  assert.deepEqual(lostNotes(before, notes), []); assert.equal(placeNotes(before, notes), false);
  // `three` moved down a line and `two` was rewritten.
  const after = built(['one'], ['2', 'new', 'three']);
  assert.deepEqual(lostNotes(after, notes).map(item => item.note), ['About two', 'About three']);
  assert.equal(placeNotes(after, notes), true);
  assert.equal(notes.get(noteKey(lineOf(after, 'three'))).note, 'About three'); assert.equal(notes.get(noteKey(lineOf(after, 'three'))).now, 3);
  assert.deepEqual(lostNotes(after, notes).map(item => item.note), ['About two']);
  const rows = changeRows(after, 100, false, { notes }), marks = rows.filter(row => row.kind === 'mark').map(row => row.text);
  assert.deepEqual(marks, ['src/a.mjs, line 1 has changed since this note. It was: two', '✎ About two', `${' '.repeat(6)}✎ About three`]);
  assert.ok(rows.filter(row => row.kind === 'mark').every(row => row.line), 'a note row carries its line, so + on it edits the note');
  assert.equal(notesMessage(notes, after), ['Notes on your changes. Change what each one asks:', '', 'src/a.mjs, line 1 as it was when I wrote this note (it has changed since): two', 'About two', '', 'src/a.mjs, line 3: three', 'About three'].join('\n'));
  // With every change gone, the note still shows.
  assert.deepEqual(changeRows({ files: [] }, 100, false, { notes }).filter(row => row.kind === 'mark').length, 4);
});

test('line notes are written beside the session record and read back; a broken file reads as none', t => {
  const { root } = project(t), repo = repository(root), line = { path: 'src/a.mjs', kind: 'add', old: null, now: 4, text: 'four' };
  assert.equal(readNotes(repo, '7').size, 0);
  saveNotes(repo, '7', new Map([[noteKey(line), { ...line, note: 'Keep me' }]]));
  const target = path.join(taskDir(repo, '7'), 'line-notes.json');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.deepEqual([...readNotes(repo, '7')], [[noteKey(line), { ...line, note: 'Keep me' }]]);
  fs.writeFileSync(target, '{ not json'); assert.equal(readNotes(repo, '7').size, 0);
  fs.writeFileSync(target, JSON.stringify({ notes: [{ path: 'a', text: 1, note: 'x' }, 'no', { path: 'a', text: 't', note: ' ' }] })); assert.equal(readNotes(repo, '7').size, 0);
  saveNotes(repo, '7', new Map()); assert.equal(fs.existsSync(target), false);
});
