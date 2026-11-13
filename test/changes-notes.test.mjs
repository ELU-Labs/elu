import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { project, fakeClis, cli, git } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { saveTask, taskDir } from '../lib/state.mjs';
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
// A project with one session that changed a line of lib/price.mjs.
function session(t) {
  const removals = [], p = project({ after: close => removals.push(close) }), fake = fakeClis(p.parent);
  const values = { ...fake.env, XDG_CONFIG_HOME: path.join(p.parent, 'personal'), NO_COLOR: '1', TERM: 'xterm-256color' }, previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
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
async function view(t, repo) {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = 100; output.rows = 30;
  output.on('data', () => {});
  let rendered, closed = false;
  const finished = launchTerminal({ repo, input, output, refreshMs: 30, startConductor: () => false, onRender: value => { rendered = value; } });
  finished.then(() => { closed = true; }, () => { closed = true; });
  await until(() => rendered, 'first render');
  const v = {
    input, get current() { return rendered; }, get changes() { return rendered.panels.changes; },
    lines: () => rendered.panels.changes.getText().split('\n'), flat: () => rendered.panels.changes.getText().split('\n').map(line => line.trim()).join(' '), status: () => rendered.panels.status.getText(),
    modal: title => rendered.screen.children.find(child => !child.destroyed && child.options?.label?.trim() === title),
    // A click as a terminal reports it: press, then release, in SGR form (1-based cells).
    click(x, y) { input.write(`\x1b[<0;${x + 1};${y + 1}M`); input.write(`\x1b[<0;${x + 1};${y + 1}m`); },
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
        rendered.panels.chat.focus(); rendered.screen.emit('keypress', 'q', { name: 'q' });
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
  input.write('d'); await until(() => rendered.sessionView === 'changes' && rendered.screen.focused === rendered.panels.changes && v.lines().some(line => line.includes(OLD)), 'its changes');
  return v;
}
const everything = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? everything(path.join(dir, item.name)) : item.isFile() ? [fs.readFileSync(path.join(dir, item.name), 'utf8')] : []).join('\n');

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
  await until(() => !/✎/.test(again.flat()), 'sent notes leave the view');
  const kept = everything(s.repo.state);
  assert.match(kept, /Notes on your changes\. Change what each one asks:/);
  assert.match(kept, /lib\/price\.mjs, removed line 2: export const price = \(value\) => value;\\nSay why the old one went/);
  assert.match(kept, /lib\/price\.mjs, line 2 as it was when I wrote this note \(it has changed since\): export const price = \(value\) => value \* \(1 \+ tax\);\\nRound it to cents/);
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
