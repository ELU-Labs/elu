import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import blessed from 'blessed';
import { chatBlock, keepParts, keepRows } from '../lib/terminal-visuals.mjs';
import { asWritten, installTerminalStyles, markdownRows, unmark } from '../lib/markdown.mjs';
import { columns } from '../lib/width.mjs';
import { project } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { launchTerminal } from '../lib/terminal.mjs';
import { approveTask, checkProposal, proposeTask, setGoal } from '../lib/plan.mjs';
import { addUpdate, readData, saveScript } from '../lib/artifacts.mjs';
import { liveTask } from './peer-helpers.mjs';

// A model's Markdown drawn for the terminal (lib/markdown.mjs): what each row shows, that every
// row fits the width, that no control character in the text reaches a row, and that the rows
// copy back to the text exactly as it was written.
const REPLY = [
  '## Coupon check',
  '',
  'The **normalize** step in `src/coupon.mjs` keeps the case, so *SAVE10* never matches.',
  '',
  '1. Read the module',
  '   - trims spaces first',
  '2. Run the coupon test',
  '',
  '| File | Change | Why it matters for the checkout flow | Risk |',
  '|------|--------|--------------------------------------|:----:|',
  '| src/coupon.mjs | upper-cases the code before the compare | codes typed in any case now match | low |',
  '',
  '```js',
  "export const normalize = (value) => String(value ?? '').trim().toUpperCase(); // a line that runs past the width of the chat pane at eighty columns and past one hundred and forty too",
  '```',
  '',
  '> The old codes keep working.',
  '',
  '---',
  '',
  'See [the notes](https://example.com/docs) or https://example.com/changelog.',
].join('\n');
const shown = row => unmark(row).replace(/\{\/?[a-z0-9-]*\}/g, '').replace(/\{open\}/g, '{').replace(/\{close\}/g, '}');
const copied = rows => {
  const out = []; let last = null;
  rows.copy.forEach(place => { if (place.skip) return; const text = [place.line].flat().map(line => rows.source[line]).join('\n'); if (!(place.cont && text === last)) out.push(text); last = text; });
  return out.join('\n');
};

test('a reply draws its heading, list, table, code, quote, rule and links inside the width, and copies back as written', () => {
  for (const width of [43, 74, 134]) {
    const rows = markdownRows(REPLY, width), plain = rows.map(shown);
    for (const row of plain) assert.ok(columns(row) <= width, `${JSON.stringify(row)} fits ${width}`);
    assert.equal(plain[0], 'Coupon check');
    assert.ok(plain.some(row => row.startsWith('The normalize step in src/coupon.mjs')));
    assert.ok(plain.includes('1. Read the module') && plain.includes('   ◦ trims spaces first'));
    assert.ok(plain.some(row => row.includes('↪')), 'the long code line carries on under ↪');
    assert.ok(plain.includes('│ The old codes keep working.'));
    assert.ok(plain.some(row => row.includes('the notes (https://example.com/docs)')), 'the address shows beside its link');
    assert.equal(copied(rows), REPLY, `copy at ${width}`);
  }
  assert.ok(markdownRows(REPLY, 74).map(shown).some(row => row.startsWith('┌')), 'the table is boxed where its words fit');
  assert.ok(markdownRows(REPLY, 43).map(shown).some(row => row.startsWith('┌')), 'a narrow chat boxes the table too');
  assert.ok(!markdownRows(REPLY, 43).map(shown).includes('Risk: low'), 'its rows are not listed by the names of its cells');
});

// A table wider than the chat of an 80-column window keeps its box lines: its cells shrink and
// wrap, a word too long for its cell carrying on in the row under it, and no word is lost.
test('a table wider than the chat at 80 columns is boxed, its cells shrunk and wrapped', () => {
  const header = ['File', 'Change', 'Why it matters for the checkout flow', 'Risk', 'Owner'], cells = ['src/coupon.mjs', 'upper-cases the code before the compare', 'codes typed in any case now match the saved ones', 'low', 'lead'];
  const table = [`| ${header.join(' | ')} |`, '|------|--------|--------------------------------------|:----:|------:|', `| ${cells.join(' | ')} |`].join('\n');
  for (const width of [41, 43]) {
    const rows = markdownRows(table, width, { colour: false }).map(shown);
    for (const row of rows) assert.ok(columns(row) <= width, `${JSON.stringify(row)} fits ${width}`);
    assert.ok(rows[0].startsWith('┌') && rows.at(-1).startsWith('└'), rows.join('\n'));
    assert.ok(!rows.some(row => /^(File|Change|Risk|Owner): /.test(row)), rows.join('\n'));
    // Each row of the box has a line between every two cells, and each cell's words are all there.
    const body = rows.filter(row => row.startsWith('│')), rule = rows.findIndex(row => row.startsWith('├'));
    for (const row of body) assert.equal([...row].filter(ch => ch === '│').length, header.length + 1, row);
    const column = (list, at) => list.map(row => row.split('│')[at + 1].trim()).join('').replace(/\s+/g, '');
    const top = body.filter((_, at) => rows.indexOf(body[at]) < rule), bottom = body.filter((_, at) => rows.indexOf(body[at]) > rule);
    header.forEach((name, at) => assert.equal(column(top, at), name.replace(/\s+/g, ''), name));
    cells.forEach((cell, at) => assert.equal(column(bottom, at), cell.replace(/\s+/g, ''), cell));
  }
});

test('a person\'s words inside a thread show as written, and end a code block the model left open', () => {
  const thread = ['you · question', asWritten('Is **this** right?\n- yes\n# no'), '', '↳ answer', '## Found\n\n```\nopen code', asWritten('you · question'), asWritten('> mine')].join('\n');
  const rows = markdownRows(thread, 40), plain = rows.map(shown);
  for (const line of ['Is **this** right?', '- yes', '# no', '> mine', 'you · question']) assert.ok(plain.includes(line), line);
  assert.ok(plain.includes('Found') && plain.some(row => row.includes('open code')));
  assert.equal(copied(rows), thread.replaceAll('', ''));
});

test('no control character in the text reaches a row', () => {
  const rows = markdownRows('# A \x1b[31mred\x1b[0m title\n\n[x](https://a.example/\x1b]8;;evil\x07) `\x1b[2J` \x9b1m\n\n```\n\x1b[41mbg\n```', 60);
  for (const row of rows) assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(row), JSON.stringify(row));
});

// A drag across a model's reply in the chat copies the reply as it was written, whatever two of
// its rows draw alike: a blank line inside its code and the fence under it, the box of a table
// and a --- under it.
async function until(check, message, timeout = 10000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const ANSWER = [
  'Run this:',
  '',
  '```js',
  'const a = 1;',
  '',
  'const b = 2;',
  '```',
  '',
  '| Name | Kind | Where | Owner | Notes |',
  '|---|---|---|---|---|',
  '| coupon check | unit test | test/coupon.test.mjs | checkout team | runs on every push to main |',
  '',
  '---',
  '',
  'Done.',
].join('\n');
// The app at columns x rows on a project whose sessions setup(repo) saves.
// styles: the italics and links the app's own screen draws (a test's screen draws neither).
async function openApp(t, setup, columns, rows, styles = null) {
  const p = project(t), repo = repository(p.root), copied = [];
  const previous = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TERM: process.env.TERM };
  Object.assign(process.env, { XDG_CONFIG_HOME: path.join(p.parent, 'personal'), TERM: 'xterm-256color' });
  setup(repo, p.root);
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = columns; output.rows = rows; output.resume();
  let shown;
  const finished = launchTerminal({ repo, input, output, refreshMs: 30, startConductor: () => false, clipboard: text => copied.push(text), onRender: value => { shown = value; } });
  finished.catch(() => {});
  t.after(async () => {
    let closed = false; finished.then(() => { closed = true; }, () => { closed = true; });
    for (const started = Date.now(); !closed && !shown.screen.destroyed && Date.now() - started < 10000;) {
      shown.panels.ask.cancel(); for (const child of [...shown.screen.children]) child.dismiss?.();
      if (Date.now() - started > 3000) process.emit('SIGHUP'); else { shown.panels.tabs[0].focus(); shown.screen.emit('keypress', 'q', { name: 'q' }); }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    input.destroy(); output.destroy();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (styles) installTerminalStyles({}, { italic: false, links: false });
  });
  await until(() => shown?.panels.board.items.length, 'the list');
  if (styles) installTerminalStyles(shown.screen, styles);
  return { shown: () => shown, input, output, copied, repo };
}
// The cursor on the session whose row matches, its chat beside the list (id: once it shows that session).
async function selectRow(opened, pattern, id = null) {
  const shown = opened.shown();
  await until(() => shown.panels.board.items.some(item => pattern.test(item.getText())), `the row ${pattern}`);
  const board = shown.panels.board; board.focus(); board.select(board.items.findIndex(item => pattern.test(item.getText())));
  if (id) await until(() => opened.shown().session === id && opened.shown().screen.focused === board, `the session ${id} shown`);
}
// The app at columns x rows with one answered session, its reply summary, open in the chat.
async function openReply(t, summary, columns, rows, styles = null) {
  const opened = await openApp(t, repo => saveTask(repo, { id: '1', kind: 'conversation', base: null, branch: null, goal: 'Show the check', state: 'answered', worktree: repo.root, createdAt: new Date().toISOString(), runs: [], reviews: [], messages: [], sessions: {}, result: { summary } }), columns, rows, styles);
  await selectRow(opened, /Show the check/);
  return opened;
}
// The screen rows of a pane, as its cells show them, and a drag from one cell to another.
const paneRows = (shown, el) => {
  const pos = el.lpos, x0 = pos.xi + el.ileft, x1 = pos.xl - 1 - el.iright;
  return { x0, x1, rows: Array.from({ length: pos.yl - pos.yi }, (_, at) => pos.yi + at).map(y => ({ y, text: shown.screen.lines[y].slice(x0, x1 + 1).map(cell => cell[1]).join('') })) };
};
const sgr = (b, x, y, up = false) => `\x1b[<${b};${x + 1};${y + 1}${up ? 'm' : 'M'}`;
const drag = (input, from, to) => { input.write(sgr(0, from.x, from.y)); input.write(sgr(32, to.x, to.y)); input.write(sgr(0, to.x, to.y, true)); };
const dialogOf = (shown, title) => shown.screen.children.find(child => !child.destroyed && child.options?.label?.trim() === title);
const dialogItems = (shown, title) => (dialogOf(shown, title)?.children.filter(child => child.type === 'list') ?? []).flatMap(list => list.items.map(item => item.getText().trimEnd()));
for (const wide of [80, 140]) {
  test(`a drag across a model's reply copies it as written, a blank line in its code, a table and a rule too (${wide} columns)`, async t => {
    const opened = await openReply(t, ANSWER, wide, 120), { input, copied } = opened, shown = opened.shown();
    await until(() => /Run this:/.test(shown.panels.chat.getText()) && /Done\./.test(shown.panels.chat.getText()), 'the reply in the chat');
    shown.screen.render();
    const chat = shown.panels.chat, pos = chat.lpos, x0 = pos.xi + chat.ileft, x1 = pos.xl - 1 - chat.iright;
    const row = y => shown.screen.lines[y].slice(x0, x1 + 1).map(cell => cell[1]).join('');
    const ys = Array.from({ length: pos.yl - pos.yi }, (_, at) => pos.yi + at);
    const first = ys.find(y => /┃ Run this:/.test(row(y))), last = ys.find(y => /┃ Done\./.test(row(y)));
    assert.ok(first !== undefined && last > first, 'the whole reply is on the screen');
    // Drawn, not shown as typed: no fence or table pipes; the table boxed, at 80 columns too.
    const drawn = ys.slice(ys.indexOf(first), ys.indexOf(last) + 1).map(row);
    assert.ok(!drawn.some(text => /```|\|---|\| Name \|/.test(text)), drawn.join('\n'));
    assert.ok(drawn.some(text => /┌─/.test(text)), drawn.join('\n'));
    input.write(sgr(0, x0, first)); input.write(sgr(32, x1, last)); input.write(sgr(0, x1, last, true));
    await until(() => copied.length, 'the copy');
    assert.equal(copied[0], ANSWER);
  });
}

// A narrower window draws the reply again, italics and all, with a part of it selected or not.
// blessed draws a frame at the new size before the panes have theirs, and so does the selection as
// it clears: a row then runs past the screen's edge, and a mark (no width) that lands first on the
// next row was put on a cell past the edge, which ended the app.
for (const selected of [false, true]) test(`a model's reply in italics stays on the screen when the window narrows from 140x100 to 80x24${selected ? ', a part of it selected' : ''}`, async t => {
  const words = Array.from({ length: 26 }, (_, at) => `*${String.fromCharCode(97 + at)}*`).join(' ');
  const opened = await openReply(t, Array.from({ length: 40 }, () => words).join('\n\n'), 140, 100, { italic: true, links: false }), { input, output, copied } = opened, shown = opened.shown();
  const reads = () => unmark(shown.panels.chat.getText()).includes('a b c d e f');
  await until(reads, 'the reply in the chat');
  shown.screen.render();
  if (selected) {
    const pos = shown.panels.chat.lpos;
    input.write(sgr(0, pos.xi + 3, pos.yi + 2)); input.write(sgr(32, pos.xl - 4, pos.yi + 8)); input.write(sgr(0, pos.xl - 4, pos.yi + 8, true));
    await until(() => copied.length, 'the copy');
  }
  assert.doesNotThrow(() => { output.columns = 80; output.rows = 24; output.emit('resize'); });
  await until(() => shown.screen.width === 80 && shown.screen.height === 24, '80x24');
  assert.doesNotThrow(() => shown.screen.render());
  assert.ok(reads());
  const chat = shown.panels.chat.lpos;
  assert.ok(chat && chat.xl <= 80 && chat.yl <= 24, 'the chat is laid out to the window');
});

// A drag that takes only a part of a long line copies that part, as it shows: the rows it takes,
// from where it starts to where it ends. A line taken whole still copies as written.
test('a drag across a part of a wrapped paragraph copies only that part', async t => {
  const long = 'This **paragraph** is long enough to wrap onto several rows of the chat at eighty columns, so a drag across two of its rows takes only the words it covers.';
  const opened = await openReply(t, `First line.\n\n${long}\n\nLast line.`, 80, 60), { input, copied } = opened, shown = opened.shown();
  await until(() => /Last line\./.test(shown.panels.chat.getText()), 'the reply in the chat');
  shown.screen.render();
  const { rows } = paneRows(shown, shown.panels.chat), start = rows.findIndex(row => /┃ This paragraph is long/.test(row.text));
  assert.ok(start >= 0 && /┃ \S/.test(rows[start + 2].text), rows.map(row => row.text).join('\n'));
  // From its third word on its first row to the middle of its second row.
  const x0 = shown.panels.chat.lpos.xi + shown.panels.chat.ileft, from = rows[start].text.indexOf('is long'), to = rows[start + 1].text.indexOf(' ', 8);
  drag(input, { x: x0 + from, y: rows[start].y }, { x: x0 + to - 1, y: rows[start + 1].y });
  await until(() => copied.length, 'the copy');
  assert.equal(copied[0], `${rows[start].text.slice(from).trimEnd()}\n${rows[start + 1].text.slice(0, to).replace(/^\s*┃ /, '')}`);
  // The whole paragraph, and the lines around it, copy as written.
  const end = rows.findIndex(row => /┃ Last line\./.test(row.text)), first = rows.findIndex(row => /┃ First line\./.test(row.text));
  drag(input, { x: x0, y: rows[first].y }, { x: x0 + 70, y: rows[end].y });
  await until(() => copied.length === 2, 'the second copy');
  assert.equal(copied[1], `First line.\n\n${long}\n\nLast line.`);
});

// The Task view draws a model's Markdown, and shows the owner's own words as he typed them: the
// session's name, his first message where the session has no Task, and a goal he set.
test('the Task view shows the owner\'s own words as he typed them and draws a model\'s Markdown', async t => {
  const at = new Date().toISOString(), MINE = 'Show me the coupon check in **every** form';
  const opened = await openApp(t, (repo, root) => {
    saveTask(repo, { id: '1', kind: 'conversation', base: null, branch: null, goal: MINE, state: 'answered', worktree: repo.root, createdAt: at, runs: [], reviews: [], messages: [{ at, text: MINE }], sessions: {}, result: { summary: 'Done.' } });
    liveTask(root, { id: '2', goal: 'Uppercase coupon codes', state: 'ready' });
    proposeTask(repo, '2', { title: 'Uppercase coupons', description: 'Make it upper case.', goal: 'Codes compare equal *whatever* their case.', objectives: ['`normalize` returns upper case'], priority: 'medium', severity: 'low' }); approveTask(repo, '2');
  }, 140, 50), shown = opened.shown();
  const task = async (pattern, id) => {
    await selectRow(opened, pattern, id); opened.input.write('\x14');
    await until(() => dialogOf(shown, 'Task'), `the Task of ${pattern}`);
    const rows = dialogItems(shown, 'Task'); dialogOf(shown, 'Task').dismiss(); await until(() => !dialogOf(shown, 'Task'), 'closed');
    return rows;
  };
  // His first message, as the session's name and as its goal.
  const first = await task(/Show me the coupon check/, '1');
  assert.equal(first[0], MINE, first.join('\n'));
  assert.equal(first[first.indexOf('Goal') + 1], MINE, first.join('\n'));
  // The model's goal and objective show their Markdown drawn.
  const model = await task(/Uppercase coupons/, '2');
  assert.equal(model[model.indexOf('Goal') + 1], 'Codes compare equal whatever their case.', model.join('\n'));
  assert.ok(model.includes('  · normalize returns upper case'), model.join('\n'));
  // A goal he set shows as he typed it.
  setGoal(opened.repo, '2', { goal: 'Keep **both** forms', objectives: ['`normalize` keeps them'] });
  await until(() => readTask(opened.repo, '2'), 'saved');
  await selectRow(opened, /Show me the coupon check/, '1');
  const his = await task(/Uppercase coupons/, '2');
  assert.equal(his[his.indexOf('Goal') + 1], 'Keep **both** forms', his.join('\n'));
  assert.ok(his.includes('  · `normalize` keeps them'), his.join('\n'));
});

// A drag across the Task view's goal copies the model's goal as it wrote it, its Markdown and all.
test('a drag across the Task view copies a model\'s goal as written', async t => {
  const GOAL = 'Make `normalize` return the code in **upper case**.';
  const opened = await openApp(t, (repo, root) => {
    liveTask(root, { id: '2', goal: 'Uppercase coupon codes', state: 'ready' });
    proposeTask(repo, '2', { title: 'Uppercase coupons', description: 'Make it upper case.', goal: GOAL, objectives: ['The coupon test passes'], priority: 'medium', severity: 'low' }); approveTask(repo, '2');
  }, 140, 50), { input, copied } = opened, shown = opened.shown();
  await selectRow(opened, /Uppercase coupons/, '2'); input.write('\x14');
  await until(() => dialogOf(shown, 'Task'), 'the Task');
  shown.screen.render();
  const list = dialogOf(shown, 'Task').children.filter(child => child.type === 'list').at(-1), { x0, x1, rows } = paneRows(shown, list);
  const label = rows.find(row => /^Goal\s*$/.test(row.text)), goal = rows.find(row => /^Make normalize return/.test(row.text));
  assert.ok(label && goal, rows.map(row => row.text).join('\n'));
  drag(input, { x: x0, y: label.y }, { x: x1, y: goal.y });
  await until(() => copied.length, 'the copy');
  assert.equal(copied[0], `Goal\n${GOAL}`);
});

// A drag across a note on the Artifacts tab copies it as the model wrote it.
test('a drag across a note on the Artifacts tab copies it as written', async t => {
  const NOTE = 'The **checkout** keeps `SAVE10` working.\n\n- one\n- two';
  const opened = await openApp(t, (repo, root) => {
    liveTask(root, { id: '2', goal: 'Uppercase coupon codes', state: 'ready' });
    proposeTask(repo, '2', { title: 'Uppercase coupons', description: 'Make it upper case.', goal: 'Codes compare equal.', objectives: ['The coupon test passes'], priority: 'medium', severity: 'low', artifacts: [{ title: 'Notes', shows: 'what was found', everyMinutes: null }] }); approveTask(repo, '2');
    addUpdate(repo, '2', 'Notes', { blocks: [{ kind: 'note', text: NOTE }] });
  }, 140, 50), { input, copied } = opened, shown = opened.shown();
  await selectRow(opened, /Uppercase coupons/, '2');
  // v typed on its row, then Enter, as the line under the box says.
  input.write('v'); await new Promise(resolve => setTimeout(resolve, 20)); input.write('\r');
  await until(() => !shown.panels.artifacts.hidden && /keeps SAVE10 working/.test(shown.panels.artifacts.getText()), 'the Artifacts tab').catch(error => { throw new Error(`${error.message}: ${opened.shown().panels.status.getText()}`); });
  shown.screen.render();
  const { x0, x1, rows } = paneRows(shown, shown.panels.artifacts);
  const top = rows.find(row => /The checkout keeps SAVE10 working\./.test(row.text)), bottom = rows.find(row => /• two/.test(row.text));
  assert.ok(top && bottom, rows.map(row => row.text).join('\n'));
  drag(input, { x: x0, y: top.y }, { x: x1 - 2, y: bottom.y });
  await until(() => copied.length, 'the copy');
  assert.equal(copied[0], NOTE);
});

// A refresh script in the Task view is code: its stars, backticks, pipes and dashes show as it
// was written, on its block, and a drag across it copies the script, its blank line too.
const SCRIPT = ['#!/bin/sh', '# Prints the last run: `cat .evals/chat.json`', 'run=$(cat .evals/chat.json)', '', 'echo "**kept** as _written_ | a | b |"', '- not a list', '---', 'printf "%s" "$run"'].join('\n');
for (const [wide, high] of [[140, 50], [80, 50]]) test(`a drag across a refresh script in the Task view copies it as written (${wide}x${high})`, async t => {
  const opened = await openApp(t, (repo, root) => {
    liveTask(root, { id: '2', goal: 'Answer more eval questions', state: 'ready' });
    proposeTask(repo, '2', checkProposal({ title: 'Chat answers at 85%', description: 'Raise the answered share.', goal: 'Answer **85%** of the eval questions.', objectives: ['Answered at 85%'], priority: 'medium', severity: 'low', criteria: [], estimateMinutes: null, artifacts: [{ title: 'Chat eval', shows: 'Answered against 85%', everyMinutes: 5 }] })); approveTask(repo, '2');
    saveScript(repo, '2', 'Chat eval', `${SCRIPT}\n`);
  }, wide, high), { input, copied } = opened, shown = opened.shown();
  await selectRow(opened, /Chat answers at 85%/, '2'); input.write('\x14');
  await until(() => dialogOf(shown, 'Task'), 'the Task');
  shown.screen.render();
  const list = dialogOf(shown, 'Task').children.filter(child => child.type === 'list').at(-1), { x0, x1, rows } = paneRows(shown, list), text = rows.map(row => row.text.trimEnd());
  // As written: every line of it on a row of its own, in its order, nothing drawn as Markdown.
  const first = text.findIndex(row => row.trim() === '#!/bin/sh'), block = text.slice(first, first + 8).map(row => row.trim());
  assert.deepEqual(block, SCRIPT.split('\n'), text.join('\n'));
  // The goal over it is the model's, and drawn.
  assert.ok(text.includes('Answer 85% of the eval questions.'), text.join('\n'));
  drag(input, { x: x0, y: rows[first].y }, { x: x1, y: rows[first + 7].y });
  await until(() => copied.length, 'the copy');
  assert.equal(copied[0], SCRIPT);
  // With the goal over it: the goal as the model wrote it, the script under its line, fenced.
  shown.screen.render();
  const again = paneRows(shown, list).rows, goal = again.find(row => row.text.trimEnd() === 'Answer 85% of the eval questions.'), last = again.find(row => row.text.trim() === 'printf "%s" "$run"');
  assert.ok(goal && last, again.map(row => row.text).join('\n'));
  drag(input, { x: x0, y: goal.y }, { x: x1, y: last.y + 1 });
  await until(() => copied.length > 1, 'the second copy');
  assert.ok(copied[1].startsWith('Answer **85%** of the eval questions.\n'), copied[1]);
  assert.ok(copied[1].endsWith(`\`\`\`\n${SCRIPT}\n\`\`\``), copied[1]);
});

// The Artifacts tab with a chart and a note in one artifact: the chart draws over the note, the
// note draws as Markdown, and a drag across the note copies it as the model wrote it; a drag from
// the chart's legend through the note copies the legend as it shows and the note as written.
test('a note under a chart on the Artifacts tab draws as Markdown and copies as written, the chart over it as it shows', async t => {
  const NOTE = 'The **last** run kept `SAVE10` working.\n\n| Run | Accuracy |\n|---|---|\n| 12 | 84% |';
  const CHART = { kind: 'chart', label: 'Over time', unit: '%', target: 85, x: ['Run 10', 'Run 11', 'Run 12'], series: [{ label: 'Accuracy', values: [86, 61, 84] }] };
  const opened = await openApp(t, (repo, root) => {
    liveTask(root, { id: '2', goal: 'Answer more eval questions', state: 'ready' });
    proposeTask(repo, '2', checkProposal({ title: 'Chat answers at 85%', description: 'Raise the answered share.', goal: 'Answer 85% of the eval questions.', objectives: ['Answered at 85%'], priority: 'medium', severity: 'low', criteria: [], estimateMinutes: null, artifacts: [{ title: 'Eval history', shows: 'accuracy by run', everyMinutes: null }] })); approveTask(repo, '2');
    addUpdate(repo, '2', 'Eval history', readData(JSON.stringify({ blocks: [CHART, { kind: 'note', text: NOTE }] })));
  }, 140, 50), { input, copied } = opened, shown = opened.shown();
  await selectRow(opened, /Chat answers at 85%/, '2');
  input.write('v'); await new Promise(resolve => setTimeout(resolve, 20)); input.write('\r');
  await until(() => !shown.panels.artifacts.hidden && /kept SAVE10 working/.test(shown.panels.artifacts.getText()), 'the Artifacts tab').catch(error => { throw new Error(`${error.message}: ${opened.shown().panels.status.getText()}`); });
  shown.screen.render();
  const { x0, x1, rows } = paneRows(shown, shown.panels.artifacts), text = rows.map(row => row.text).join('\n');
  const legend = rows.find(row => /● Accuracy 84%/.test(row.text)), top = rows.find(row => /The last run kept SAVE10 working\./.test(row.text)), bottom = rows.findLast(row => /│ 12\s+│ 84%\s+│/.test(row.text));
  assert.ok(legend && top && bottom && legend.y < top.y && top.y < bottom.y, text);
  // Drawn: the chart with its axis and target, the note with no star, backtick or pipe row.
  assert.match(text, /100% ┤/); assert.match(text, /╌ target ≥ 85%/); assert.match(text, /┌─/);
  assert.ok(!/\*\*|`|\|---/.test(text), text);
  drag(input, { x: x0, y: top.y }, { x: x1 - 2, y: bottom.y });
  await until(() => copied.length, 'the copy');
  assert.equal(copied[0], NOTE);
  drag(input, { x: x0, y: legend.y }, { x: x1 - 2, y: bottom.y });
  await until(() => copied.length > 1, 'the second copy');
  assert.match(copied[1].split('\n')[0], /● Accuracy 84%/);
  assert.ok(copied[1].endsWith(NOTE), copied[1]);
});

// A long chat of Markdown replies: a reply that comes reads only itself again, not the whole chat.
test('a long chat of Markdown replies reads only what changed when a reply comes', { timeout: 60000 }, async t => {
  const reply = n => REPLY.replace('## Coupon check', `## Check ${n}`);
  const started = Date.now() - 3600000, at = n => new Date(started + n * 60000).toISOString();
  const messages = [{ at: at(0), text: 'Show the checks' }, ...Array.from({ length: 30 }, (_, n) => ({ at: at(n + 1), bot: 'reviewer', text: reply(n) }))];
  const opened = await openApp(t, repo => saveTask(repo, { id: '1', kind: 'conversation', base: null, branch: null, goal: 'Show the checks', state: 'answered', worktree: repo.root, createdAt: at(0), runs: [], reviews: [], messages, sessions: {}, result: { summary: 'Done.' } }), 140, 50), shown = opened.shown();
  await selectRow(opened, /Show the checks/);
  const chat = shown.panels.chat;
  await until(() => /Check 29/.test(chat.getText()), 'the replies in the chat');
  let read = 0; const parse = chat._parseTags;
  chat._parseTags = function (text) { read += String(text).length; return parse.call(this, text); };
  saveTask(opened.repo, { ...readTask(opened.repo, '1'), messages: [...messages, { at: at(40), bot: 'reviewer', text: reply(30) }] });
  await until(() => /Check 30/.test(chat.getText()), 'the new reply');
  assert.ok(read > 0 && read < chat.content.length / 5, `read ${read} of ${chat.content.length} characters`);
});

// The chat given as its messages (keepParts) reads into the rows, the lines they come from and
// the colours blessed gives its whole text, at any width, as one message changes, and with a
// message that leaves a colour open for the next.
test('a chat given as its messages reads into the same rows and colours as its whole text', () => {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = 100; output.rows = 40; output.resume();
  const screen = blessed.screen({ input, output, terminal: 'xterm-256color', smartCSR: true, fullUnicode: true, warnings: false, autoPadding: false, dockBorders: false });
  try {
    keepRows(screen);
    const pane = () => blessed.box({ parent: screen, top: 0, left: 0, width: 60, height: 30, border: 'line', tags: true, scrollable: true, alwaysScroll: true, padding: { left: 2, right: 2 }, scrollbar: { ch: '┃' } });
    const whole = pane(), parted = keepParts(pane());
    const block = (text, markdown, width = 52) => chatBlock({ title: '@lead', time: '1:05 AM', text, tone: 'violet', width, colour: true, markdown });
    const same = (parts, why) => {
      whole.setContent(parts.join('\n\n')); parted.setParts(parts); screen.render();
      for (const key of ['rtof', 'ftor', 'fake', 'mwidth', 'attr', 'ci', 'width', 'content']) assert.deepEqual(parted._clines[key], whole._clines[key], `${why}: ${key}`);
      assert.deepEqual([...parted._clines], [...whole._clines], why); assert.equal(parted._pcontent, whole._pcontent, why);
    };
    const parts = [block(REPLY, true), block('Plain words with 🚀 and 漢字 in them, {braces} too, and a line long enough to wrap twice in a pane this narrow.', false), 'x'.repeat(130), '', block('**Done.** See `the log`.', true), 'Working · step 1'];
    same(parts, 'first');
    same([...parts.slice(0, -1), 'Working · step 2'], 'one message changed');
    same([...parts, block('One more.', true)], 'one more');
    whole.width = parted.width = 44; same(parts.map(part => part), 'narrower');
    same(['{red-fg}left open', 'the next message', '{/red-fg}closed'], 'a colour left open');
    same(['{red-fg}a{blue-fg}b{/blue-fg}c{/red-fg} {bold}{underline}d{/bold}e{/underline} {/}f {foo}g{/foo} {open}h{close} {escape}{bold}i{/escape}', '{red-fg}{/}j {/bold}k {}l'], 'tags of every kind');
    same(['{center}centred', 'the next'], 'an alignment');
  } finally { screen.destroy(); }
});
