import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import blessed from 'blessed';
import { project, fakeClis, cli, git } from './helpers.mjs';
import { liveTask } from './peer-helpers.mjs';
import { repository } from '../lib/git.mjs';
import { nameProject, registerProject } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { saveInstructions } from '../lib/project-settings.mjs';
import { launchTerminal } from '../lib/terminal.mjs';
import { saveTask } from '../lib/state.mjs';
import { addCard } from '../lib/kanban.mjs';
import { columns, units, unitWidth, head, tail, cut, padEnd, padStart, unitBefore, unitAfter } from '../lib/width.mjs';
import { cellText } from '../lib/terminal-cells.mjs';
import { chatBlock, chatBar, teamPanes, membersLine, fitWords, ink, keyHints, keepRows, peerName, remote, visible, wrapText, roomTarget } from '../lib/terminal-visuals.mjs';
import { boardRows, barCells, barColumns, rowTitle } from '../lib/board.mjs';
import { fitCard, fitTeammateCard } from '../lib/kanban.mjs';
import { agentTable } from '../lib/agent-spend.mjs';
import { changeRows } from '../lib/changes.mjs';
import { buildChanges } from '../lib/diff.mjs';
import { firstWords } from '../lib/state.mjs';
import { layout, position, indexAt, editKey, editable } from '../lib/editor.mjs';
import { terminalModel, heldCells, OLD } from './terminal-model.mjs';

// A row with an emoji or a CJK character garbled the screen: blessed drew 🚀 in one column
// where the terminal gives it two, and the app measured rows by counting characters. A
// Changes line "🚀 Launch notes: the uploader" drew as "Launchtnotes: the uplwader" and the
// pane's right border left its column.

// What a real terminal gave each text: tmux 3.4, asked where its cursor stood after writing
// it (the cursor position report). The app's width is held against it.
const TERMINAL = [
  ['🚀', 2], ['✅', 2], ['❌', 2], ['⚠️', 2], ['⚠', 1], ['❤️', 2], ['中', 2], ['한', 2], ['あ', 2], ['Ａ', 2],
  ['👨‍👩‍👧', 2], ['🇯🇵', 2], ['👍🏽', 2], ['1️⃣', 2], ['🏳️‍🌈', 2], ['👩🏽‍💻', 2], ['é', 1], ['🇯', 2], ['🏽', 2],
  ['a‍b', 2], ['䷀', 2], ['𝐀', 1], ['कि', 2], ['กำ', 2], ['한', 2], ['🏴\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}', 2],
  ['a­b', 3], ['↔️', 2], ['ℹ️', 2], ['⭐', 2], ['☃', 1], ['☔', 2], ['©️', 2], ['™️', 2],
];
const SAMPLES = {
  'no wide character': 'Write the launch notes for the uploader',
  'one emoji': '🚀 Launch notes: the uploader',
  'two emoji': 'Launch notes ✅ shipped 🚀 for the uploader',
  'five wide characters': '修复上传器 the release notes of it',
  'all wide characters': '修复上传器的发布说明并且更新所有的测试用例和文档',
  'emoji sequences': '👨‍👩‍👧 family 🇯🇵 flag 👍🏽 tone ⚠️ warn 1️⃣ key é mark 👩🏽‍💻 dev',
};
const TEXTS = Object.values(SAMPLES), WIDTHS = Array.from({ length: 181 }, (_, at) => 20 + at);
const wideIn = text => units(text).filter(unit => unitWidth(unit) === 2).length;

test('the samples hold 0, 1, 2 and 5 wide characters, and emoji made of several code points', () => {
  assert.deepEqual(TEXTS.slice(0, 4).map(wideIn), [0, 1, 2, 5]);
  assert.ok(wideIn(SAMPLES['all wide characters']) > 20);
  assert.deepEqual(units(SAMPLES['emoji sequences']).filter(unit => unit.length > 2), ['👨‍👩‍👧', '🇯🇵', '👍🏽', '1️⃣', '👩🏽‍💻']);
});

test('the width of a text is the columns a real terminal gave it', () => {
  for (const [text, wide] of TERMINAL) assert.equal(columns(text), wide, `${JSON.stringify(text)} ${[...text].map(ch => ch.codePointAt(0).toString(16)).join(' ')}`);
  assert.equal(columns('abc'), 3); assert.equal(columns(''), 0); assert.equal(columns(null), 0);
  // A character is what the terminal draws as one: Backspace takes all of it.
  assert.deepEqual(units('a👨‍👩‍👧b🇯🇵é中'), ['a', '👨‍👩‍👧', 'b', '🇯🇵', 'é', '中']);
  assert.equal(columns(TEXTS.join('')), TEXTS.reduce((sum, text) => sum + columns(text), 0));
  for (const text of TEXTS) assert.equal(columns(text), units(text).reduce((sum, unit) => sum + unitWidth(unit), 0));
});

test('a text cut for width is cut between two characters, with its mark, and never wider than asked', () => {
  for (const text of TEXTS) {
    const all = units(text), starts = new Set(); let at = 0; for (const unit of all) { starts.add(at); at += unit.length; } starts.add(at);
    for (let width = 0; width <= columns(text) + 2; width++) {
      const start = head(text, width), end = tail(text, width), short = cut(text, width), dots = cut(text, width, '...');
      assert.ok(columns(start) <= width && starts.has(start.length) && text.startsWith(start), `head of ${text} at ${width}`);
      assert.ok(columns(start) > width - 2 || start === text, `head of ${text} at ${width} uses its room`);
      assert.ok(columns(end) <= width && starts.has(text.length - end.length) && text.endsWith(end), `tail of ${text} at ${width}`);
      assert.ok(columns(short) <= width && columns(dots) <= width, `cut of ${text} at ${width}`);
      if (columns(text) <= width) { assert.equal(short, text); assert.equal(dots, text); }
      else if (width >= 1) { assert.ok(short.endsWith('…') && starts.has(short.length - 1) && text.startsWith(short.slice(0, -1)), `cut of ${text} at ${width}: ${short}`); if (width >= 3) assert.ok(dots.endsWith('...') && starts.has(dots.length - 3)); }
      assert.equal(columns(padEnd(short, width)), width); assert.equal(columns(padStart(short, width)), width);
      assert.ok(columns(fitWords(text, width)) <= width && columns(firstWords(text, Math.max(2, width))) <= Math.max(2, width), `words of ${text} at ${width}`);
      for (const row of wrapText(text, Math.max(8, width))) assert.ok(columns(row) <= Math.max(8, width), `a wrapped row of ${text} at ${width}`);
      assert.equal(wrapText(text, Math.max(8, width)).join(' ').replace(/\s+/g, ''), text.replace(/\s+/g, ''), `wrapping ${text} at ${width} loses nothing`);
    }
    // From any place in the text, the character before and the one after are whole.
    const bounds = [...starts].sort((a, b) => a - b);
    for (let index = 0; index <= text.length; index++) {
      assert.equal(unitBefore(text, index), index === 0 ? 0 : bounds.findLast(start => start < index), `before ${index} in ${text}`);
      assert.equal(unitAfter(text, index), index >= text.length ? text.length : bounds.find(start => start > index), `after ${index} in ${text}`);
    }
  }
});

// Some texts are capped by length before they reach a row: a blocked command at 80, a
// teammate's text at its limit, the end of a long path. The cap can fall inside an emoji, and
// the half it leaves is no character: it takes no column and is not drawn.
test('a text capped by length in the middle of an emoji shows no half of it, and its row keeps its columns', t => {
  const whole = 'Run npm test 🚀', capped = whole.slice(0, -1), ending = `…${whole.slice(-1)} done`;
  assert.equal(columns(capped), 13); assert.equal(columns(`${capped}…`), 14); assert.equal(columns(ending), 6);
  assert.equal(columns(padEnd(`${capped}…`, 18)), 18);
  assert.equal(columns(remote(`${'a'.repeat(29)}🚀 and more`, 30)), 29);
  const { screen, terms, show } = stage(t, 40, 6);
  framed(screen, 20, 4, { content: `${capped}…\n${ending}` }); show();
  for (const [kind, term] of Object.entries(terms)) {
    assert.equal(term.grid[1].slice(0, 20).join(''), `│Run npm test …${' '.repeat(4)}│`, `the ${kind} terminal, a cap that ends in half an emoji`);
    assert.equal(term.grid[2].slice(0, 20).join(''), `│… done${' '.repeat(12)}│`, `the ${kind} terminal, a cap that starts in half an emoji`);
  }
});

// The app's screen, drawn into two terminals: one of today, which draws every character as
// wide as the table above says, and one that joins nothing (a family of three is three
// pictures, ⚠️ is one column). A pane is put at the left, a fence after its last column.
function stage(t, width = 212, height = 32) {
  const input = new PassThrough(), output = new PassThrough(); input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = width; output.rows = height;
  let bytes = ''; output.write = chunk => { bytes += chunk; return true; };
  const screen = blessed.screen({ input, output, terminal: 'xterm-256color', smartCSR: true, fullUnicode: true, warnings: false, autoPadding: false, dockBorders: false });
  keepRows(screen); t.after(() => screen.destroy());
  blessed.box({ parent: screen, top: 0, left: 0, width: '100%', height: '100%' });
  const terms = { today: terminalModel(width, height), old: terminalModel(width, height, OLD) };
  return { screen, terms, show() { screen.render(); screen.program.flush(); for (const term of Object.values(terms)) term.write(bytes); bytes = ''; } };
}
const framed = (screen, width, height, options = {}) => blessed.box({ parent: screen, top: 0, left: 0, width, height, border: 'line', tags: false, ...options });
// lib/terminal.mjs pane(): a list inside its frame; its last column is the scroll bar.
const listIn = frame => blessed.list({ parent: frame, top: 1, left: 1, width: '100%-2', height: '100%-2', tags: true, invertSelected: false, style: { selected: { bold: true } }, scrollbar: { ch: '┃' } });
const EDGE = { top: ['┌', '┐'], side: ['│', '│'], bottom: ['└', '┘'] };
// build(screen, width): { top, height, framed, rows: [[y, x, text, room]] }, the rows it expects on the screen.
function sweep(t, name, build, widths = WIDTHS) {
  const { screen, terms, show } = stage(t);
  for (const width of widths) {
    const made = build(screen, width), fence = blessed.box({ parent: screen, top: 0, left: width, width: 3, height: made.height, border: 'line' });
    show();
    for (const [kind, term] of Object.entries(terms)) {
      assert.equal(term.wrapped, 0, `${name} at ${width}: the ${kind} terminal never wraps a row itself`);
      for (let y = 0; y < made.height; y++) {
        const edge = EDGE[y === 0 ? 'top' : y === made.height - 1 ? 'bottom' : 'side'], row = term.grid[y].join('');
        assert.equal(term.grid[y][width], edge[0], `${name} at ${width}, row ${y}, ${kind} terminal: nothing runs past the pane: ${row}`);
        if (made.framed) assert.deepEqual([term.grid[y][0], term.grid[y][width - 1]], edge, `${name} at ${width}, row ${y}, ${kind} terminal: the borders are in their columns: ${row}`);
      }
    }
    // Today's terminal shows what the app holds, cell for cell, and each row as it was built.
    assert.deepEqual(terms.today.grid.map(row => row.join('')), heldCells(screen, cellText).map(row => row.join('')), `${name} at ${width}`);
    for (const [y, x, text, room] of made.rows) {
      assert.ok(columns(text) <= room, `${name} at ${width}: a row is ${columns(text)} columns in a room of ${room}: ${text}`);
      assert.equal(terms.today.grid[y].slice(x, x + room).join('').trimEnd(), text.trimEnd(), `${name} at ${width}, row ${y}`);
    }
    made.top.destroy(); fence.destroy();
  }
}
// A row built with the app's tags, as the text it shows.
const shown = line => visible(line).replace(/\x03/g, '');

const NOW = Date.parse('2026-11-08T20:00:00Z'), ago = minutes => new Date(NOW - minutes * 60000).toISOString();
const SESSIONS = boardRows([{ name: 'shop', root: '/p/shop', activity: [], queue: [], tasks: TEXTS.map((goal, at) => ({ id: String(at + 1), state: 'answered', kind: 'conversation', goal, result: { summary: 'Done.' }, runs: [{ role: 'lead', at: ago(30 + at) }], messages: [], createdAt: ago(40 + at) })) }], NOW).filter(row => row.kind === 'task');

test('a Sessions row is as wide as its list at every width from 20 to 200, with its age at the right edge and a title that fits whole', t => {
  assert.equal(SESSIONS.length, TEXTS.length);
  sweep(t, 'Sessions', (screen, width) => {
    const frame = framed(screen, width, SESSIONS.length + 2), list = listIn(frame), room = Math.max(8, list.width - 2), shared = barColumns(SESSIONS, room - 1);
    const lines = SESSIONS.map(row => ` ${barCells(row, room - 1, NOW, shared).map(cell => ink(cell.text, cell.tone, true, cell.bold)).join('')}`);
    list.setItems(lines);
    for (const [at, row] of SESSIONS.entries()) {
      const cells = barCells(row, room - 1, NOW, shared), text = shown(lines[at]), title = rowTitle(row, NOW), left = room - 1 - columns(cells[0].text) - columns(cells.at(-1).text);
      assert.equal(columns(text), room, `the row is as wide as the list at ${width}: ${text}`);
      assert.match(text, /\d+m$/, `the age is at the right edge at ${width}: ${text}`);
      if (columns(title) <= left) assert.ok(text.includes(title), `a title that fits is whole at ${width}: ${text}`); else assert.ok(text.includes('…'), `a title cut for width says so at ${width}: ${text}`);
    }
    return { top: frame, height: SESSIONS.length + 2, framed: true, rows: lines.map((line, at) => [at + 1, 1, shown(line), room]) };
  });
});

test('a chat message keeps every row behind its bar and inside the pane at every width from 20 to 200', t => {
  sweep(t, 'the chat', (screen, width) => {
    // lib/terminal.mjs activity and chatWidth: a border, two columns of padding, the scroll bar's column.
    const frame = framed(screen, width, 30, { tags: true, scrollable: true, alwaysScroll: true, padding: { left: 2, right: 2 }, scrollbar: { ch: '┃' } }), room = Math.max(10, width - 7);
    const content = [chatBlock({ title: 'You', time: '5:12 PM', text: SAMPLES['two emoji'], tone: 'blue', shaded: true, width: room }),
      chatBlock({ title: '@sec', time: '5:13 PM', text: `Done ✅ shipped 🚀\n${SAMPLES['all wide characters']} ${SAMPLES['emoji sequences']}`, tone: 'violet', width: room })].join('\n');
    frame.setContent(content);
    const rows = content.split('\n').map(shown);
    assert.deepEqual(frame._clines.map(row => cellText(row.replace(/\x1b\[[\d;]*m/g, '').replace(/\x03/g, ''))), rows, `blessed wraps no row a second time at ${width}`);
    assert.ok(rows.filter(row => row.startsWith('┃')).length >= 3 && rows.every(row => row.startsWith('┃') || /5:1\d PM$/.test(row)), `every row of a message is behind its bar at ${width}`);
    if (room >= 45) assert.ok(rows.includes(padEnd(`┃ ${SAMPLES['two emoji']}`, room)), `a message that fits is one whole row at ${width}`);
    return { top: frame, height: 30, framed: true, rows: rows.slice(0, 28).map((row, at) => [at + 1, 3, row, room]) };
  });
});

test('a title and a key bar are cut to their row at every width from 20 to 200, between two characters', t => {
  const PAIRS = [['enter', 'open 修复上传器'], ['n', 'new 🚀 session'], ['esc', 'back'], ['/', 'commands'], ['q', 'quit']];
  sweep(t, 'a one-row text', (screen, width) => {
    const texts = [...TEXTS.flatMap(text => [fitWords(text, width), cut(text, width, '...')]), shown(keyHints(PAIRS, width, true)), shown(keyHints([['/rename 修复上传器的发布说明并且更新所有的测试用例', 'names it']], width, true))];
    const top = blessed.box({ parent: screen, top: 0, left: 0, width, height: texts.length });
    texts.forEach((text, at) => blessed.text({ parent: top, top: at, left: 0, width, height: 1, tags: true, content: ink(text, 'text', true, true) }));
    TEXTS.forEach((text, at) => { if (columns(text) <= width) assert.deepEqual(texts.slice(at * 2, at * 2 + 2), [text, text], `a title that fits is whole at ${width}`); else assert.ok(texts[at * 2].endsWith('…') && texts[at * 2 + 1].endsWith('...'), `a title cut for width says so at ${width}`); });
    assert.ok(texts.at(-2).startsWith('enter open 修复') && texts.at(-1).startsWith('/rename 修复'), `the key bar keeps its first key at ${width}`);
    return { top, height: texts.length, framed: false, rows: texts.map((text, at) => [at, 0, text, width]) };
  });
});

const PATCH = ['diff --git a/NOTES.md b/NOTES.md', 'index 1111111..2222222 100644', '--- a/NOTES.md', '+++ b/NOTES.md', '@@ -1,2 +1,6 @@', ' # Notes', '+🚀 Launch notes: the uploader', '+修复上传器的发布说明 ✅ done', `+${SAMPLES['emoji sequences']}`, `+${SAMPLES['all wide characters']}${SAMPLES['all wide characters']}`, ' last line',
  'diff --git a/文档/发布说明.md b/文档/发布说明.md', 'index 3333333..4444444 100644', '--- a/文档/发布说明.md', '+++ b/文档/发布说明.md', '@@ -1 +1,2 @@', ' 标题', '+上传器 🚀', ''].join('\n');
const CHANGES = buildChanges({ base: 'a1b2c3d4'.repeat(5), branch: 'feat/修复上传器', patch: PATCH });

test('the Changes view keeps a line with an emoji whole and its border in column at every width from 20 to 200', t => {
  assert.deepEqual(CHANGES.files.map(file => file.path), ['NOTES.md', '文档/发布说明.md']);
  sweep(t, 'Changes', (screen, width) => {
    // lib/terminal.mjs: a row is the cursor's mark, the text, then the scroll bar's column. The pane does not wrap.
    const high = 26, frame = framed(screen, width, high + 2, { tags: true, wrap: false }), room = Math.max(8, width - 4);
    const rows = changeRows(CHANGES, room, true, { open: new Set(CHANGES.files.keys()) }).slice(0, high);
    frame.setContent(rows.map((row, at) => `${ink(at === 2 ? '▌' : ' ', 'orange', true)}${row.text}${' '.repeat(Math.max(0, room - columns(visible(row.text))))}${at === 0 ? ink('┃', 'dim', true) : ' '}`).join('\n'));
    const texts = rows.map(row => shown(row.text));
    if (room >= 40) assert.ok(texts.some(text => text.trimEnd().endsWith('+ 🚀 Launch notes: the uploader')), `the line is whole at ${width}: ${texts.join(' | ')}`);
    assert.ok(texts.map(text => text.replace(/^[\s\d]*[+-]?\s/, '')).join('').replace(/\s/g, '').includes('🚀Launchnotes:theuploader'), `no part of the line is lost at ${width}`);
    return { top: frame, height: high + 2, framed: true, rows: texts.map((text, at) => [at + 1, 2, text, room]) };
  });
});

test('a Kanban card keeps its title and its detail inside its column at every width from 20 to 200', t => {
  const CARDS = [...TEXTS.map(title => ({ title, detail: 'answered · 4m ago' })), ...TEXTS.map(title => ({ title, detail: 'to approve · high · 修复', plan: true })), ...TEXTS.map(title => ({ title, detail: '@小林 on 开发机 🖥 · working', teammate: true }))];
  sweep(t, 'Kanban', (screen, width) => {
    const frame = framed(screen, width, CARDS.length + 2), list = listIn(frame), room = Math.max(4, list.width - 2);
    const cards = CARDS.map(item => {
      // lib/terminal.mjs: a card is its title first; the detail goes beside it as far as it fits.
      const card = item.teammate ? fitTeammateCard(item.title, item.detail, room, 2) : item.plan ? fitCard(item.title, item.detail, room) : null, title = card ? card.title : fitWords(item.title, room), left = room - columns(title) - 2;
      return { title, detail: card ? card.detail : item.detail && left >= Math.min(columns(item.detail), 12) ? cut(item.detail, left, '...') : '' };
    });
    const lines = cards.map(card => ink(card.title, 'text', true, true) + (card.detail ? ink(`  ${card.detail}`, 'muted', true) : ''));
    list.setItems(lines);
    CARDS.forEach((item, at) => { if (columns(item.title) <= room && !item.teammate) assert.equal(cards[at].title, item.title, `a title that fits is whole at ${width}`); else if (columns(item.title) > room) assert.ok(cards[at].title.endsWith('…'), `a title cut for width says so at ${width}: ${cards[at].title}`); });
    assert.ok(cards.slice(-TEXTS.length).every(card => room < 12 || card.detail.startsWith('@小林')), `a teammate's card keeps their name at ${width}`);
    return { top: frame, height: CARDS.length + 2, framed: true, rows: lines.map((line, at) => [at + 1, 1, shown(line), room]) };
  });
});

test('a Usage row keeps its columns under their headers at every width from 20 to 200', t => {
  const AGENTS = TEXTS.map((title, at) => ({ agent: at % 2 ? '@审查' : '@lead', title, where: at % 3 ? 'on 开发机' : '', model: 'opus 5.5', tokens: { input: 1200000, output: 34000, cacheRead: 8100000, cacheWrite: 0 }, costUsd: 12.4 - at, partial: false }));
  sweep(t, 'Usage', (screen, width) => {
    const frame = framed(screen, width, AGENTS.length + 3), list = listIn(frame), room = Math.max(8, list.width - 2), table = agentTable(AGENTS, { width: room, total: 60 });
    list.setItems(table.map(text => ink(cut(text, room, '...'), 'text', true)));
    // Each column starts in the same screen column on every row: the header's.
    const model = table[0].indexOf('Model'); if (model >= 0) for (const row of table.slice(1)) { assert.equal(columns(head(row, model)), model, `no character straddles the model column at ${width}: ${row}`); assert.ok(row.slice(head(row, model).length).startsWith('opus 5.5'), `the model is under its header at ${width}: ${row}`); }
    return { top: frame, height: AGENTS.length + 3, framed: true, rows: table.map((text, at) => [at + 1, 1, text, room]) };
  });
});

const ME = 'a'.repeat(64), LIN = 'b'.repeat(64), SAM = 'c'.repeat(64);
const TEAM = { id: 'team-1', name: '核心 🚀', members: [{ key: ME, name: 'ana' }, { key: LIN, name: '小林', online: true }, { key: SAM, name: 'sam👍🏽' }], channels: [{ id: 'c1', name: '设计 🎨', members: [ME, LIN, SAM] }] };
const PEERS = { status: { key: ME, teams: [TEAM] }, agents: [{ name: '小林', peer: LIN, online: true, rows: [{ handle: 'lead', label: '修复上传器', now: SAMPLES['two emoji'], taskId: '1' }] }], items: [
  { id: 'a', kind: 'incoming', peer: LIN, name: '小林', team: true, room: { team: 'team-1', channel: 'c1' }, text: SAMPLES['all wide characters'], at: ago(1) },
  { id: 'b', kind: 'held', peer: SAM, name: 'sam👍🏽', text: SAMPLES['two emoji'], at: ago(2) },
  { id: 'c', kind: 'asked', peer: null, name: 'team', team: true, room: { team: 'team-1', channel: null }, text: SAMPLES['one emoji'], at: ago(3) },
] };

test('Chats rows, a teammate\'s name and a channel\'s line stay inside their panes at every width from 20 to 200', t => {
  sweep(t, 'Chats', (screen, width) => {
    const frame = framed(screen, width, 28), list = listIn(frame), room = Math.max(8, list.width - 2), [bar, work] = teamPanes(PEERS, [room, room - 2, room], true);
    const open = bar.find(row => row.value?.type === 'room' && row.value.channel === 'c1').value;
    const lines = [...bar, ...work.map(row => ({ ...row, line: `  ${row.line}` })), ...teamPanes(PEERS, [room, room - 2, room], true, roomTarget('team-1', 'c1'), `#${open.name}`)[2], ...teamPanes(PEERS, [room, room - 2, room], true)[2], { line: membersLine(open, room, true) }].map(row => row.line).slice(0, 26);
    list.setItems(lines);
    assert.ok(lines.some(line => shown(line).includes('@小林')), `the teammate is named at ${width}`);
    return { top: frame, height: 28, framed: true, rows: lines.map((line, at) => [at + 1, 1, shown(line), room]) };
  });
});

test('a dialog\'s text and its list of choices stay inside it at every width from 20 to 200', t => {
  const body = `${SAMPLES['emoji sequences']}\n\n${SAMPLES['all wide characters']} ${SAMPLES['two emoji']}\n- ${SAMPLES['five wide characters']} and more words to wrap under the mark`;
  const OPTIONS = [{ name: '修复上传器', note: SAMPLES['two emoji'] }, { name: 'docs 🚀', note: SAMPLES['all wide characters'] }, { name: 'plain', note: 'a plain note' }];
  sweep(t, 'a dialog', (screen, width) => {
    // lib/terminal.mjs prompt: the body wrapped to the text box, then the choices in two columns.
    const frame = framed(screen, width, 30), text = blessed.box({ parent: frame, top: 1, left: 2, width: '100%-4', height: '100%-2', tags: true, scrollable: true }), wide = Math.max(8, text.width - 1);
    const column = Math.max(0, ...OPTIONS.map(row => columns(row.name))) + 2;
    const lines = [...wrapText(body, wide), '', ...OPTIONS.map((row, at) => `${ink(at ? ' ' : '>', 'orange', true, true)} ${ink(padEnd(row.name, column), null, true, !at)}${ink(fitWords(row.note, wide - column - 2), 'muted', true)}`)].slice(0, 28);
    text.setContent(lines.join('\n'));
    assert.equal(wrapText(body, wide).join(' ').replace(/\s+/g, ''), body.replace(/\s+/g, ''), `the body is whole at ${width}`);
    return { top: frame, height: 30, framed: true, rows: lines.map((line, at) => [at + 1, 2, shown(line), wide]) };
  });
});

test('the message box wraps what is typed between two characters and keeps its border at every width from 20 to 200', t => {
  const typed = `${SAMPLES['two emoji']} ${SAMPLES['all wide characters']} ${SAMPLES['emoji sequences']}`;
  sweep(t, 'the message box', (screen, width) => {
    const field = blessed.textarea({ parent: screen, top: 0, left: 0, width, height: 12, border: 'line', label: ' Message ', inputOnFocus: false, keys: true, mouse: true, tags: false, padding: { left: 1, right: 1 } });
    editable(field); field.setValue(typed);
    const view = field.editorView(), rows = view.rows.map(row => typed.slice(row.start, row.end));
    assert.equal(view.width, width - 5); assert.equal(rows.join('').replace(/\s/g, ''), typed.replace(/\s/g, ''), `nothing typed is lost at ${width}`);
    // The cursor, at every character: its column is the columns of the row before it, inside the box.
    let at = 0; for (const unit of units(typed)) { const spot = position(typed, view.rows, at, view.charWidth), row = view.rows[spot.row]; assert.ok(spot.col <= view.width && spot.col === columns(typed.slice(row.start, Math.min(at, row.end))), `the cursor before ${unit} at ${width}`); assert.equal(indexAt(typed, view.rows, spot.row, spot.col, view.charWidth), Math.min(at, row.end), `a click at the cursor's cell at ${width}`); at += unit.length; }
    // The box shows the rows around the cursor, which is at the end.
    const base = field.childBase || 0;
    return { top: field, height: 12, framed: true, rows: rows.slice(base, base + 10).map((row, no) => [no + 1, 2, row, view.width]) };
  });
});

test('in the message box the cursor steps over a whole character, Backspace and Delete take all of it, and a click lands on its start', () => {
  const value = 'a👨‍👩‍👧中é🇯🇵👍🏽z', all = units(value), starts = [0]; for (const unit of all) starts.push(starts.at(-1) + unit.length);
  assert.deepEqual(all, ['a', '👨‍👩‍👧', '中', 'é', '🇯🇵', '👍🏽', 'z']);
  const view = { width: 40 }, key = (state, name, extra = {}) => editKey(state, undefined, { name, ...extra }, view);
  // Left from the end, then Right to the end: every stop is between two characters.
  let state = { value, cursor: value.length, goal: null }; const back = [];
  for (let step = 0; step < all.length; step++) { state = key(state, 'left'); back.push(state.cursor); }
  assert.deepEqual(back, starts.slice(0, -1).reverse());
  const forth = []; for (let step = 0; step < all.length; step++) { state = key(state, 'right'); forth.push(state.cursor); }
  assert.deepEqual(forth, starts.slice(1));
  // Backspace from the end removes one character a press, the last first.
  for (let left = all.length; left > 0; left--) { state = key(state, 'backspace'); assert.equal(state.value, all.slice(0, left - 1).join(''), `Backspace took ${all[left - 1]}`); assert.equal(state.cursor, state.value.length); }
  // Delete from the start removes the first.
  state = { value, cursor: 0, goal: null };
  for (let gone = 1; gone <= all.length; gone++) { state = key(state, 'delete'); assert.equal(state.value, all.slice(gone).join(''), `Delete took ${all[gone - 1]}`); }
  // Typing an emoji or a CJK character puts the cursor after it, and its column is the columns typed.
  state = { value: '', cursor: 0, goal: null };
  for (const [text, column] of [['🚀', 2], ['中', 4], ['a', 5], ['👨‍👩‍👧', 7], ['é', 8]]) { state = editKey(state, text, { name: undefined, sequence: text }, view); const rows = layout(state.value, 40); assert.equal(position(state.value, rows, state.cursor).col, column, `after typing ${text}`); }
  assert.equal(key(key(state, 'backspace'), 'backspace').value, '🚀中a');
  // A click on either cell of a wide character puts the cursor before it; the cell after it, after it.
  const rows = layout(value, 40);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(col => indexAt(value, rows, 0, col)), [0, 1, 1, 9, 9, 10, 12, 12, 16, 16, 20, 21]);
  // A row never ends inside a character, and none is wider than the box.
  for (let width = 2; width <= 30; width++) for (const row of layout(`${value} ${value}`, width)) { const text = `${value} ${value}`.slice(row.start, row.end); assert.ok(columns(text) <= width && units(text).join('') === text && [...starts, ...starts.map(start => start + value.length + 1)].includes(row.start), `a row at ${width}: ${JSON.stringify(text)}`); }
});

// The app itself, as bin/elu-code.mjs starts it, drawing into the two terminals. The project
// holds a session named in CJK whose answer has ✅ and 🚀, a session that changed a line to
// "🚀 Launch notes: the uploader", and a Kanban card written in CJK.
const until = async (check, message, timeout = 15000) => { const started = Date.now(); while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${typeof message === 'function' ? message() : message}`); await new Promise(resolve => setTimeout(resolve, 10)); } };
const ANSWER = 'Done ✅ shipped 🚀 the uploader notes.\n修复完成 ✅ 所有测试通过 🚀', NAME = '修复上传器的发布说明', LINE = '🚀 Launch notes: the uploader';
// name: what the project is called. peer: the team this computer is on, as lib/peer/index.mjs
// answers the app. more(repo, at): sessions beside the two every test has.
async function app(t, [width, height], { name = null, peer = undefined, more = null } = {}) {
  const closers = []; t.after(async () => { let failure = null; for (const close of closers.reverse()) { try { await close(); } catch (error) { failure ??= error; } } if (failure) throw failure; });
  const p = project({ after: close => closers.push(close) }), fake = fakeClis(p.parent, { mode: 'answer' }), home = path.join(p.parent, 'home');
  for (const name of ['claude', 'codex']) fs.mkdirSync(path.join(home, name), { recursive: true });
  const env = { ...fake.env, XDG_CONFIG_HOME: path.join(p.parent, 'personal'), TERM: 'xterm-256color', NCURSES_NO_UTF8_ACS: '1' }, before = Object.fromEntries([...Object.keys(env), 'NO_COLOR'].map(key => [key, process.env[key]]));
  Object.assign(process.env, env); delete process.env.NO_COLOR;
  closers.push(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  assert.equal(cli(p.root, ['init', '--yes'], fake.env).status, 0);
  git(p.root, ['add', '.']); git(p.root, ['commit', '-m', 'Configure checks']);
  const repo = repository(p.root), at = new Date(Date.now() - 60000).toISOString(); registerProject(repo);
  saveTask(repo, { id: '1', kind: 'conversation', goal: NAME, state: 'answered', worktree: p.root, branch: null, base: null, createdAt: at, runs: [], reviews: [], responses: [], sessions: {}, result: { outcome: 'done', intent: 'answer', summary: ANSWER, question: null, choices: [], comments: [], responses: [] }, messages: [{ at, text: NAME }] });
  liveTask(p.root, { id: '2', goal: 'Write the launch notes', state: 'ready', files: { 'NOTES.md': `# Notes\n${LINE}\n${NAME} ✅ done\n` } });
  addCard(repo, `${NAME} 🚀 并且更新文档`);
  if (name) nameProject(projectFolder(p.root), name);
  more?.(repo, at);
  const input = new PassThrough(), output = new PassThrough(); input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = width; output.rows = height;
  const models = (columns, rows) => ({ today: terminalModel(columns, rows), old: terminalModel(columns, rows, OLD) });
  let terms = models(width, height), rendered;
  output.on('data', value => { for (const term of Object.values(terms)) term.write(value.toString()); });
  const finished = launchTerminal({ repo, peer, usage: { home, env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex') }, vendors: () => [] }, input, output, refreshMs: 30, startConductor: () => false, onRender: value => { rendered = value; } });
  finished.catch(() => {});
  await until(() => rendered, 'first render');
  // A draw that throws leaves the screen half drawn: every one is watched.
  const failed = [], draw = rendered.screen.render; rendered.screen.render = function (...args) { try { return draw.apply(this, args); } catch (error) { failed.push(error); throw error; } };
  closers.push(async () => {
    let closed = false, stopped = false; finished.then(() => { closed = true; }, () => { closed = true; });
    if (!rendered.screen.destroyed) Promise.resolve().then(() => rendered.controller?.close()).then(() => { stopped = true; }, () => { stopped = true; });
    for (const started = Date.now(); !closed && !rendered.screen.destroyed;) {
      const waited = Date.now() - started;
      if (waited > 10000) { input.destroy(); output.destroy(); throw new Error('The view did not close after its test.'); }
      if (stopped || waited > 3000) { rendered.panels.ask.cancel(); for (const child of [...rendered.screen.children]) child.dismiss?.(); if (waited > 3000) process.emit('SIGHUP'); else { rendered.panels.chat.focus(); rendered.screen.emit('keypress', 'q', { name: 'q' }); } }
      await new Promise(resolve => setTimeout(resolve, stopped ? 20 : 2));
    }
    input.destroy(); output.destroy();
  });
  const text = pane => cellText(pane.getText().replace(/\x03/g, '')), listed = () => rendered.panels.board.items.map(text);
  const v = {
    input, get current() { return rendered; }, text, listed,
    // Today's terminal as text, once it shows what the app holds. Both terminals are then checked: no row wrapped, every border in its column.
    async screen(where) {
      const held = () => heldCells(rendered.screen, cellText).map(row => row.join('')), drawn = () => terms.today.grid.map(row => row.join(''));
      const differs = () => { const a = drawn(), b = held(), rows = a.flatMap((row, y) => row === b[y] ? [] : [`row ${y}:\n  the terminal shows ${JSON.stringify(row)}\n  the app holds      ${JSON.stringify(b[y])}`]); return rows.length ? `${where}, ${rows.length} rows differ, ${rows.slice(0, 4).join('\n')}` : null; };
      // The app sets a pane's text on every pass and puts it on the screen only when something changed: until then blessed
      // holds that pane as blank. So the screen is drawn here first, then read once the terminal has what was written.
      await until(() => { rendered.screen.render(); return failed.length || differs() === null; }, differs, 8000);
      assert.deepEqual(failed.map(error => error.stack), [], `${where}: the app drew without an error`);
      for (const [kind, term] of Object.entries(terms)) {
        assert.equal(term.wrapped, 0, `${where}: the ${kind} terminal wrapped no row by itself`);
        rendered.screen.lines.forEach((line, y) => line.forEach((cell, x) => { if ('│┌┐└┘'.includes(cell[1]) && cell[1]) assert.equal(term.grid[y][x], cell[1], `${where}: the border at row ${y}, column ${x} on the ${kind} terminal: ${term.grid[y].join('')}`); }));
      }
      return drawn();
    },
    async sized(columns, rows) {
      if (rendered.screen.width === columns && rendered.screen.height === rows) return;
      await new Promise(resolve => setImmediate(resolve));
      terms = models(columns, rows); output.columns = columns; output.rows = rows; output.emit('resize');
      await until(() => rendered.screen.width === columns && rendered.screen.height === rows, `${columns} by ${rows}`);
    },
    async send(value) { const ask = rendered.panels.ask; ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box'); ask.setValue(value); ask.submit(); },
    async open(pattern) {
      if (rendered.view !== 'tasks') await v.send('/tasks');
      await until(() => rendered.view === 'tasks' && listed().some(row => pattern.test(row)), `row ${pattern}`);
      const board = rendered.panels.board; board.focus(); board.select(listed().findIndex(row => pattern.test(row)));
      await until(() => pattern.test(listed()[board.selected] ?? '') && rendered.screen.focused === board, `row ${pattern} under the cursor`);
      input.write('\r'); await until(() => rendered.screen.focused === rendered.panels.ask && rendered.session, 'its chat');
    },
  };
  return v;
}
const SIZES = [[80, 24], [140, 50]];

test('the app at 80 by 24 and 140 by 50: a session named in CJK, an answer with ✅ and 🚀, the Changes line and a Kanban card keep every border in its column', { timeout: 120000 }, async t => {
  const v = await app(t, SIZES[0]);
  for (const [width, height] of SIZES) {
    const where = step => `${step} at ${width} by ${height}`;
    await v.sized(width, height);
    // The session named in CJK, open: its row in the list, its title, its answer.
    await v.open(/修复上传器/);
    await until(() => /Done ✅ shipped 🚀/.test(v.text(v.current.panels.chat)), 'the answer');
    let rows = await v.screen(where('the chat'));
    const bar = v.current.panels.boardBox.width, right = row => row.endsWith('│') || row.endsWith('┐') || row.endsWith('┘');
    assert.ok(rows.some(row => row.includes(`✓ ${NAME}`) || row.includes('✓ 修复上传器')), where('the Sessions row is named in CJK'));
    assert.ok(rows[1].includes(NAME) && rows[1].includes('answered'), `${where('the title')}: ${rows[1]}`);
    assert.ok(rows.some(row => row.includes('┃ Done ✅ shipped 🚀 the uploader notes.')) && rows.some(row => row.includes('┃ 修复完成 ✅ 所有测试通过 🚀')), where('the answer is whole'));
    assert.ok(bar >= 24 && rows.slice(2, height - 10).every(right), `${where('every row of the chat ends at its border')}:\n${rows.join('\n')}`);
    // Typing and deleting in the message box: the text stands where it was typed, and Backspace takes one whole character.
    const ask = v.current.panels.ask, typed = '你好🚀 abc ✅中文👍🏽';
    for (const piece of units(typed)) v.input.write(piece);
    await until(() => ask.value === typed, () => `the typed text, got ${JSON.stringify(ask.value)}`);
    rows = await v.screen(where('typing'));
    assert.ok(rows.some(row => row.includes(`│ ${typed} `) && right(row)), `${where('what was typed is in the message box')}:\n${rows.slice(-8).join('\n')}`);
    for (const left of ['你好🚀 abc ✅中文', '你好🚀 abc ✅中', '你好🚀 abc ✅', '你好🚀 abc ', '你好🚀 abc', '你好🚀 ab']) { v.input.write('\x7f'); await until(() => ask.value === left, () => `Backspace to ${JSON.stringify(left)}, got ${JSON.stringify(ask.value)}`); }
    rows = await v.screen(where('deleting'));
    assert.ok(rows.some(row => row.includes('│ 你好🚀 ab ') && right(row)), `${where('Backspace took one character each time')}:\n${rows.slice(-8).join('\n')}`);
    ask.setValue('');
    // The Changes view of the other session.
    await v.open(/Write the launch/); await v.send('/changes');
    await until(() => v.current.sessionView === 'changes' && v.text(v.current.panels.changes).includes(LINE), 'its changes');
    rows = await v.screen(where('Changes'));
    assert.ok(rows.some(row => row.includes(`+ ${LINE} `) && right(row)), `${where('the Changes line is whole, its border after it')}:\n${rows.join('\n')}`);
    assert.ok(rows.some(row => row.includes(`+ ${NAME} ✅ done`) && right(row)), where('the line under it too'));
    assert.ok(rows.slice(2, height - 10).every(right), `${where('every row of Changes ends at its border')}:\n${rows.join('\n')}`);
    await v.send('/chat');
    // Kanban: the card written in CJK, and the session named in CJK.
    await v.send('/kanban'); await until(() => v.current.view === 'kanban' && v.current.panels.kanbanLists.some(list => list.items.some(item => v.text(item).includes('修复上传器'))), 'Kanban');
    rows = await v.screen(where('Kanban'));
    assert.ok(rows.join('\n').split('修复上传器').length >= 3, `${where('a card and a session are titled in CJK')}:\n${rows.join('\n')}`);
    await v.send('/tasks');
  }
});

test('the app at every width from 80 to 200: the open session, its list and its message box stay in their columns', { timeout: 240000 }, async t => {
  const v = await app(t, [80, 30]);
  await v.open(/修复上传器/);
  for (const piece of units('你好🚀 ✅中文')) v.input.write(piece);
  await until(() => v.current.panels.ask.value === '你好🚀 ✅中文', 'the typed text');
  for (let width = 80; width <= 200; width++) {
    await v.sized(width, 30);
    const rows = await v.screen(`the chat at ${width}`);
    assert.ok(rows[1].includes('修复上传器'), `the title at ${width}: ${rows[1]}`);
    assert.ok(rows.slice(2, 20).every(row => row.endsWith('│') || row.endsWith('┐')), `every row ends at its border at ${width}:\n${rows.join('\n')}`);
    assert.ok(rows.some(row => row.includes('┃ Done ✅ shipped 🚀 the uploader notes.')), `the answer at ${width}`);
    assert.ok(rows.some(row => row.includes('│ 你好🚀 ✅中文 ') && row.endsWith('│')), `the message box at ${width}`);
  }
});

// Rows that other work of this release added, drawn by the app itself: a project a teammate
// shares that is not on this computer (its row in Projects and its team board), a project's
// settings with the rows that name its default model, and a Sessions row that is typed on.
// Each holds a name in CJK or with an emoji, at every width from 80 to 200.
const OWN = '🚀 店铺', TITLED = '🚀 Ship the uploader ✅ 发布', SHARED_WITH = [{ id: 'team-1', name: TEAM.name }];
const sharer = (key, name, box, online) => ({ key, name, box, online, mine: false, handle: 'shop', title: 'Shop', older: false });
const SHOP = { id: '9'.repeat(64), name: '🚀 Launch 店铺', handle: 'shop', repoId: '9'.repeat(64), address: 'https://github.com/acme/shop.git', teams: SHARED_WITH, sharers: [sharer(LIN, '小林', '开发机', true)] };
const DOCS = { id: '8'.repeat(64), name: SAMPLES['all wide characters'], handle: 'docs', repoId: '8'.repeat(64), address: null, teams: SHARED_WITH, sharers: [sharer(SAM, 'sam👍🏽', '文档机 🖥', false)] };
// This computer on a team, as lib/peer/index.mjs answers the app: who is on it, what they share, and each shared project's team board.
function teamOf(shared) {
  const just = minutes => new Date(Date.now() - minutes * 60000).toISOString(), member = (key, name, extra) => ({ key, fingerprint: key.slice(0, 8), name, role: 'member', online: true, path: 'direct', lastSeen: just(0), ...extra });
  const board = row => {
    const who = row.sharers[0], from = { peer: who.key, name: who.name, box: who.box, online: who.online, heardAt: just(0) };
    const task = { repoId: row.repoId, handle: row.handle, id: 't-0a1b2c3d', revision: 1, title: '修复登录重定向 ✅ 并且更新文档', description: '', goal: '登录后回到原来的页面 🚀', objectives: [], priority: 'high', severity: 'high', state: 'approved', startedBy: 'owner', who: 'Opus 5.5', subtasks: [], met: [], approvedAt: just(30), doneAt: null, updatedAt: just(2) };
    return { row, plans: [{ ...from, tasks: [task] }], sessions: [{ ...from, sessions: [{ repoId: row.repoId, id: '0123456789abcdef', title: '修复购物车合计 🚀 Fix the cart total', column: 'needs', by: who.name, at: just(1) }] }] };
  };
  return {
    onTeam: () => true,
    peerStatus: () => ({ running: true, stale: false, pid: 1, key: ME, name: 'ana', fingerprint: 'aaaaaaaa', error: null, counters: { direct: 1, relayed: 0, failed: 0 }, teams: [{ id: 'team-1', name: TEAM.name, role: 'admin', channels: [], members: [member(ME, 'ana', { role: 'admin', path: null }), member(LIN, '小林', { box: '开发机' }), member(SAM, 'sam👍🏽', { box: '文档机 🖥', online: false, path: null })] }] }),
    peerItems: () => [], teamAgents: () => [], tickerEvents: () => [], mineRows: () => [], remoteSessions: () => [], remoteMachines: () => [], projectRepoId: () => null,
    teamAccess: () => ({ handling: 'auto', rules: '', root: null, at: just(60) }),
    teammateProjects: () => shared,
    teammateProjectBoard: id => { const row = shared.find(value => value.id === id); return row ? board(row) : null; },
  };
}
const ends = row => row.endsWith('│') || row.endsWith('┐') || row.endsWith('┘');
// The screen column a text starts in, on a row of today's terminal, and that row cell by cell.
const columnOf = (row, text) => { const at = row.indexOf(text); return at < 0 ? -1 : columns(row.slice(0, at)); };
const cellsOf = row => units(row).flatMap(unit => unitWidth(unit) === 2 ? [unit, ''] : unitWidth(unit) ? [unit] : []);
// The longest of the forms that fits the room, else the last: how the app picks a line for a row.
const longest = (room, ...forms) => forms.find(form => columns(form) <= room) ?? forms.at(-1);

test('the app at every width from 80 to 200: Projects lists a project named with an emoji, one a teammate shares named with an emoji and one named in CJK, and that one\'s team board says whose it is in a line that fits', { timeout: 600000 }, async t => {
  const v = await app(t, [80, 30], { name: OWN, peer: teamOf([SHOP, DOCS]) }), panels = () => v.current.panels;
  const who = peerName('sam👍🏽', SAM), machine = `@${remote('文档机 🖥', 32).replace(/[\s@]+/g, '')}`, short = cut(DOCS.name, 30, '...');
  assert.equal(columns(DOCS.name), 48); assert.equal(columns(short), 29); assert.ok(columns(who) > who.length - 3 && columns(machine) > machine.length);
  for (let width = 80; width <= 200; width++) {
    await v.sized(width, 30);
    // Projects: this computer's project, then the two a teammate shares. Each column starts under the one above.
    await v.send('/projects');
    await until(() => v.current.view === 'projects' && panels().projectsList.items.length === 3, 'the three projects');
    let rows = await v.screen(`Projects at ${width}`);
    const list = panels().projectsList, room = Math.max(20, list.width - 2), left = tail => Math.max(4, room - 26 - tail.length - 2);
    const mine = `● ${padEnd(OWN, 24)}`, shop = `  ${padEnd(SHOP.name, 24)}${padEnd(cut('shared by @小林   on @开发机', left('online'), '...'), left('online') + 2)}online`;
    const docs = `  ${padEnd(cut(DOCS.name, 22, '...'), 24)}${padEnd(cut(`shared by ${who}   on ${machine}`, left('offline'), '...'), left('offline') + 2)}offline`;
    assert.equal(columns(docs), room, `a shared project's row is as wide as the list at ${width}`);
    const found = [mine, shop, docs].map(text => rows.find(row => row.includes(text)));
    assert.ok(found.every(row => row && ends(row)), `the three rows at ${width}, each ending at the border:\n${rows.join('\n')}`);
    assert.deepEqual([columnOf(found[0], OWN), columnOf(found[1], SHOP.name), columnOf(found[2], DOCS.name.slice(0, 4))], [3, 3, 3], `the names start in one column at ${width}`);
    assert.deepEqual([columnOf(found[1], 'shared by'), columnOf(found[2], 'shared by')], [27, 27], `who shares it starts in one column at ${width}`);
    assert.equal(columnOf(found[1], 'online') + 'online'.length, columnOf(found[2], 'offline') + 'offline'.length, `online and offline end in one column at ${width}`);
    // Enter on the one named in CJK: its team board, under its name and who shares it.
    list.focus(); list.select(2); v.input.write('\r');
    await until(() => v.current.view === 'kanban' && v.text(panels().ask._label).includes('Message') && /The box below writes to/.test(v.text(panels().status)), 'its team board');
    rows = await v.screen(`the team board at ${width}`);
    const title = `${DOCS.name}  ·  shared by ${who}  ·  on ${machine}`;
    assert.ok(rows[1].includes(cut(title, panels().header.width, '...')) && columns(rows[1]) === width, `the title at ${width}: ${rows[1]}`);
    if (columns(title) <= panels().header.width) assert.ok(rows[1].includes(title), `a title that fits is whole at ${width}`);
    // The line under the board, the box's label and the status line are each the longest form that fits, whole.
    const whose = `${who}'s project, on ${machine}`, note = longest(width - 4, `${short} is ${whose}, not on this computer. A message here starts a session there.`, `${short} is ${whose}, not on this computer.`, `${short} is ${whose}.`, 'Not on this computer.');
    assert.ok(rows.includes(`│ ${padEnd(note, panels().kanbanTeam.width - 3)}│`), `the line under the board at ${width} is ${note}:\n${rows.join('\n')}`);
    const label = longest(panels().ask.width - 4, ` Message ${who} about ${short} · starts a session on their computer, under the access they chose `, ` Message ${who} about ${short} · starts a session there `, ` Message ${who} about ${short} `, ` Message ${who} `);
    assert.equal(v.text(panels().ask._label), label, `the box's label at ${width}`);
    assert.ok(rows.some(row => row.includes(`─${label}─`) && row.endsWith('┐')), `the label is inside the box's border at ${width}:\n${rows.slice(-8).join('\n')}`);
    const said = longest(panels().status.width - 3, `${DOCS.name}, shared by ${who} on ${machine}. The box below writes to ${who}.`, `The box below writes to ${who}.`);
    assert.ok(rows.some(row => row.trimEnd() === `› ${said}` || row.trimEnd() === ` › ${said}`), `the status line at ${width} is ${said}:\n${rows.slice(-8).join('\n')}`);
    // Its cards: a teammate's Task and a session of theirs, titled in CJK with an emoji.
    assert.ok(rows.some(row => row.split('修复').length === 3 && cellsOf(row).filter(cell => cell === '│').length === 8), `the two cards, each inside its column, at ${width}:\n${rows.join('\n')}`);
    if (width >= 160) assert.ok(rows.some(row => row.includes('修复登录重定向') && row.includes('修复购物车合计')), `the cards say more of their titles at ${width}:\n${rows.join('\n')}`);
  }
});

test('the app at every width from 80 to 200: the settings of a project named with an emoji keep every row inside the dialog, the two that name its default model among them', { timeout: 600000 }, async t => {
  const TEXT = `${SAMPLES['all wide characters']} 🚀 and more words than the row has room for`;
  const v = await app(t, [80, 30], { name: OWN, more: repo => saveInstructions(repo.root, `${TEXT}\nA second line.\n`) }), panels = () => v.current.panels, PAGE = `Project ${OWN}`;
  const dialog = () => v.current.screen.children.find(child => !child.destroyed && child.options?.label?.trim() === PAGE);
  await v.send('/projects');
  await until(() => v.current.view === 'projects' && panels().projectsList.items.length === 1, 'the project');
  panels().projectsList.focus(); v.input.write('\r'); await until(dialog, 'its settings');
  for (let width = 80; width <= 200; width++) {
    await v.sized(width, 30);
    const rows = await v.screen(`the settings at ${width}`), box = dialog(), top = rows[box.atop], inside = rows.slice(box.atop + 1, box.atop + box.height - 1);
    assert.equal(box.width, Math.min(88, width - 4));
    assert.equal(columnOf(top, `┌─ ${PAGE} ─`), box.aleft, `the dialog's title at ${width}: ${top}`);
    for (const row of inside) assert.deepEqual([cellsOf(row).length, cellsOf(row)[box.aleft], cellsOf(row)[box.aleft + box.width - 1]], [width, '│', '│'], `a row of the dialog has its two borders in their columns at ${width}: ${row}`);
    assert.equal(cellsOf(top)[box.aleft + box.width - 1], '┐', `the dialog's corner at ${width}: ${top}`);
    const text = label => inside.find(row => row.includes(label));
    assert.ok(text(`Instructions  ${cut(TEXT, 48, '...')}`), `the instructions row, cut between two characters at ${width}:\n${inside.join('\n')}`);
    assert.ok(text('Default model Opus · not chosen, so the first installed here') && text('This computer not chosen · Opus, the first installed here'), `the rows that name the model at ${width}:\n${inside.join('\n')}`);
    assert.deepEqual(['● Active project', 'Instructions', 'Context', 'Default model', 'This computer', 'Archive'].map(label => columnOf(text(label), label)), Array(6).fill(box.aleft + 1), `every row starts in the dialog's first column at ${width}`);
  }
});

test('the app at every width from 80 to 200: typing on the Sessions row of a session titled with an emoji writes in the message box, and the row, the title and the box keep their columns', { timeout: 600000 }, async t => {
  const v = await app(t, [80, 30], { more: (repo, at) => saveTask(repo, { id: '3', kind: 'conversation', goal: TITLED, state: 'answered', worktree: repo.root, branch: null, base: null, createdAt: at, runs: [], reviews: [], responses: [], sessions: {}, result: { outcome: 'done', intent: 'answer', summary: ANSWER, question: null, choices: [], comments: [], responses: [] }, messages: [{ at, text: TITLED }] }) });
  const panels = () => v.current.panels, board = panels().board, ask = panels().ask, typed = 'c你好🚀 ✅中文👍🏽';
  if (v.current.view !== 'tasks') await v.send('/tasks');
  await until(() => v.current.view === 'tasks' && v.listed().some(row => row.includes('🚀 Ship')), 'the row titled with an emoji');
  board.focus(); board.select(v.listed().findIndex(row => row.includes('🚀 Ship')));
  await until(() => v.current.screen.focused === board && (v.listed()[board.selected] ?? '').includes('🚀 Ship') && v.text(panels().header).includes('🚀 Ship'), 'that row under the cursor');
  // One letter typed on the row is its key once Enter follows; the line under the box says which.
  v.input.write('c'); await until(() => ask.value === 'c' && v.current.screen.focused === ask, 'the letter in the message box');
  let rows = await v.screen('a letter typed on the row');
  assert.match(v.text(panels().keys), /enter archives this session · keep typing to write a message/);
  // More typed after it is a message, with an emoji, CJK and a thumb with a skin tone.
  for (const piece of units(typed.slice(1))) v.input.write(piece);
  await until(() => ask.value === typed, () => `the typed text, got ${JSON.stringify(ask.value)}`);
  for (let width = 80; width <= 200; width++) {
    await v.sized(width, 30);
    rows = await v.screen(`a Sessions row typed on at ${width}`);
    const wide = panels().boardBox.width, row = rows.find(value => value.includes('✓ 🚀 Ship'));
    assert.ok(row, `the row at ${width}:\n${rows.join('\n')}`);
    // The list's right border is in its column on that row, and the pane beside it ends at the screen's edge.
    assert.deepEqual([cellsOf(row).length, cellsOf(row)[wide - 1]], [width, '│'], `the list's border on the row at ${width}: ${row}`);
    assert.ok(row.includes(TITLED) || row.includes('…'), `the row's title is whole or cut with its mark at ${width}: ${row}`);
    assert.ok(rows[1].includes('🚀 Ship') && rows[1].includes('answered'), `the title beside the list at ${width}: ${rows[1]}`);
    assert.ok(rows.slice(2, 18).every(ends), `every row ends at its border at ${width}:\n${rows.join('\n')}`);
    assert.ok(rows.some(value => value.includes(`│ ${typed} `) && value.endsWith('│')), `the message box at ${width}:\n${rows.slice(-8).join('\n')}`);
  }
  ask.setValue('');
});
