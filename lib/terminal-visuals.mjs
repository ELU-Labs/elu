import blessed from 'blessed';
import { redact } from './publish.mjs';
import { sanitize } from './peer/peerdata.mjs';

// Explicit xterm indices avoid the library's hex matcher reducing accents to ANSI basics.
export const PALETTE = Object.freeze({ background: 233, panel: 234, raised: 235, highlight: 237, border: 238, dim: 241, text: 255, muted: 247, orange: 209, blue: 75, green: 79, red: 203, violet: 141, gold: 221, pink: 212, lime: 149, aqua: 80, rose: 174 });

// Escape terminal controls and Blessed markup before applying our own styles. trusted: text
// from a trusted teammate shows as sent; everything else is masked.
export const displayText = (value, { trusted = false } = {}) => (trusted ? String(value ?? '').slice(0, 512000) : redact(String(value ?? ''), 512000)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/[{}]/g, ch => ch === '{' ? '{open}' : '{close}');
export function ink(value, tone, colour = true, bold = false, { trusted = false } = {}) {
  const text = displayText(value, { trusted }), fg = colour && tone ? `{${PALETTE[tone]}-fg}` : '', end = fg ? '{/}' : '';
  return `${fg}${bold ? '{bold}' : ''}${text}${bold ? '{/bold}' : ''}${end}`;
}
export function relativeTime(value, now = Date.now()) {
  if (!Number.isFinite(Date.parse(value))) return 'not reported';
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60000));
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}
// Strips our tags to measure what the terminal will show.
export const visible = value => String(value ?? '').replace(/\{(open|close)\}/g, '\x00').replace(/\{\/?[a-z0-9-]*\}/g, '').replace(/\x00/g, '.');
// The key bar: each key in bold, its action muted; pairs that do not fit are dropped from the end.
export function keyHints(pairs, width, colour) {
  const shown = [];
  for (const [key, label] of pairs) {
    const text = `${ink(key, 'text', colour, true)} ${ink(label, 'muted', colour)}`;
    if (visible([...shown, text].join('  ')).length > width) break;
    shown.push(text);
  }
  return shown.join('  ');
}

// Row 0 holds the brand and the six tabs, row 1 the view's buttons and title. The message
// box shows four lines of text above a one-row key bar, with a status row over it.
export function terminalLayout(width, height) {
  const askHeight = 6, top = 2, keysTop = height - 1, askTop = keysTop - askHeight, statusTop = askTop - 1;
  return { width, height, wide: width >= 120 && height >= 28, top, keysTop, askTop, askHeight, statusTop };
}

// Names and text from another machine: one line, no escapes, bidi or zero-width tricks.
// A trusted teammate's text shows as sent; anyone else's is masked too.
export const remote = (value, max = 400, { trusted = false } = {}) => (trusted ? sanitize(value, max) : redact(sanitize(value, max), max)).replace(/\s+/g, ' ').trim();
export const shortKey = key => String(key ?? '').replace(/[^0-9a-f]/gi, '').slice(0, 8);
export const peerName = (name, key) => `@${remote(name, 40).replace(/[\s@]+/g, '') || shortKey(key) || 'peer'}`;
// A person keeps one colour wherever Chats names them. You are blue, as in a session. A
// teammate's colour is their place among everyone on your teams, ordered by key, so two
// machines on one team show the same person in the same colour.
const PEOPLE = ['violet', 'gold', 'pink', 'lime', 'aqua', 'rose'];
export function peopleTones(status) {
  const keys = [...new Set((Array.isArray(status?.teams) ? status.teams : []).flatMap(team => Array.isArray(team?.members) ? team.members : []).map(member => member?.key).filter(key => typeof key === 'string' && key))].sort();
  return new Map(keys.map((key, at) => [key, key === status?.key ? 'blue' : PEOPLE[at % PEOPLE.length]]));
}
// Who a thread is with: a teammate, or the whole team for a team ask nobody took yet.
export const threadWho = item => item?.team && !item.peer ? 'your team' : peerName(item?.name, item?.peer);
// Cuts at a word boundary; only a single word longer than the width is cut inside.
export function fitWords(value, width) {
  const text = String(value ?? '').replace(/\s/g, ' ').trimEnd();
  if (text.length <= width) return text;
  if (width < 2) return text.slice(0, Math.max(0, width));
  const cut = text.slice(0, width - 1), space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
export const clockTime = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '--:--';
const rows = value => Array.isArray(value) ? value.filter(row => row && typeof row === 'object') : [];
const THREAD = { answering: ['←', 'asks you', 'text'], replied: ['→', 'replied', 'green'], failed: ['←', 'asks you', 'muted'], declined: ['←', 'asks you', 'muted'], incoming: ['←', 'asks you', 'orange'], held: ['→', 'reply ready', 'orange'], draft: ['→', 'draft to send', 'orange'], asked: ['→', 'asked', 'text'], answer: ['←', 'answered', 'green'], expired: ['→', 'expired', 'muted'], rejected: ['→', 'rejected', 'muted'] };
const NEEDS_OWNER = ['incoming', 'held', 'draft'];
// A bot's name, and the kinds of thread I started (the rest are a teammate's requests to me).
const BOT = /^[a-z][a-z0-9-]{0,29}$/, MINE = ['asked', 'answer', 'expired', 'rejected'];
// [message, reply]: each [text, tone]. A teammate's question shows my side under it; my
// question shows theirs. The question is item.question when item.text holds the reply.
function threadRows(item, who) {
  // A bot is named beside the teammate whose machine runs it.
  const bot = BOT.test(item.bot ?? '') ? `@${item.bot}` : null;
  const trusted = item.trusted === true, text = remote(item.text, 400, { trusted }), question = remote(item.question, 400, { trusted }) || text, mine = !['incoming', 'answering', 'held', 'replied', 'failed'].includes(item.kind);
  // Pictures come before the message's words, so a long message cannot push them off the
  // row: how many on one I sent, how many and how large on one I got. The opened message
  // lists each name and size.
  const pictures = item.pictures?.list?.length ? item.pictures : null;
  const sent = !pictures ? '' : pictures.unsent ? `, ${remote(pictures.count, 20)} not sent` : ` with ${remote(pictures.count, 20)}`, got = pictures ? ` with ${remote(pictures.count, 20)} (${remote(pictures.size, 12)})` : '';
  const message = item.kind === 'draft' ? [`→ draft to send to ${who} · ${question}`, 'orange'] : mine ? [`→ you asked ${bot ? `${bot} (${who})` : who}${sent} · ${question}`, 'text']
    : [`← ${who} ${item.request === 'handoff' ? 'sends you a task' : item.team ? 'asks the team' : bot ? `asks your bot ${bot}` : 'asks you'}${got} · ${question}`, item.kind === 'incoming' ? 'orange' : 'text'];
  const reply = {
    answering: ['your model is answering…', 'muted'], failed: ['your model could not answer', 'muted'], declined: ['you declined', 'muted'],
    held: [`reply ready${item.blocked ? ', held: possible secret' : ''} · ${text}`, 'orange'], replied: [`you replied · ${text}`, 'green'],
    asked: pictures?.unsent ? [`${remote(item.state, 30) || 'sent'} · ${remote(pictures.unsent, 300)}`, 'orange'] : [remote(item.state, 30) || 'sent', 'muted'], answer: [`${bot ?? who} answered · ${text}`, 'green'],
    expired: ['expired', 'muted'], rejected: [`rejected · ${text}`, 'muted'],
  }[item.kind] ?? null;
  return [message, reply];
}
// Lines for the Chats panes: teammates, their live agents and threads. Each row keeps the value its keys act on.
// The Chats bar, like a chat app's: Channels (#general is everyone on a team, then the
// channels this machine is in), then Direct messages (each teammate). A row's target is
// what the message box writes to and which threads show beside it.
export const roomTarget = (team, channel) => `room\0${team}\0${channel ?? ''}`, dmTarget = key => `dm\0${key}`;
// A bot's row: mine (no peer), or a teammate's shared bot.
export const botTarget = (peer, name) => `bot\0${peer ?? ''}\0${name}`;
// The bar row a thread belongs to: its channel, #general for a team ask, else the teammate.
export function threadTarget(item, status) {
  const teams = rows(status?.teams), holding = key => teams.find(team => rows(team.members).some(m => m.key === key)) ?? teams[0];
  // What I asked a teammate's bot lists under that bot while they still share it. Their requests to my bots list under them.
  if (item?.bot && item.peer && MINE.includes(item.kind)) {
    const shared = teams.some(team => rows(team.members).some(m => m.key === item.peer && rows(m.bots).some(bot => bot.name === item.bot)));
    return shared ? botTarget(item.peer, item.bot) : dmTarget(item.peer);
  }
  if (item?.room || item?.team) {
    const team = teams.find(row => row.id === item.room?.team) ?? holding(item.peer);
    if (!team) return null;
    return roomTarget(team.id, item.room?.channel && rows(team.channels).some(row => row.id === item.room.channel) ? item.room.channel : null);
  }
  if (item?.peer) return dmTarget(item.peer);
  // A draft names its teammate by name only.
  const named = teams.flatMap(team => rows(team.members)).find(m => m.key !== status?.key && peerName(m.name, m.key) === peerName(item?.name));
  return named ? dmTarget(named.key) : teams[0] ? roomTarget(teams[0].id, null) : null;
}
// What the Team list says before there is a team: what a team is, how to invite, how to join.
export const NO_TEAM = [
  "No team yet. A team lets you and your teammates ask each other's ELU Code about the projects you share.",
  '',
  'To invite someone:',
  '1. Type !elu team create NAME, with any name for your team.',
  '2. Type /invite and send them the code it shows.',
  '',
  'Got a code? Type /join and the code.',
].join('\n');
export function chatBar({ status, items, trusted = [], bots = [] }, width, colour) {
  const line = (text, tone, bold) => ink(fitWords(text, width), tone, colour, bold);
  const teams = rows(status?.teams), trust = new Set(Array.isArray(trusted) ? trusted : []), bar = [], people = new Map(), waiting = new Map(), toneOf = peopleTones(status);
  if (!teams.length) return wrapText(NO_TEAM, width).map(text => ({ line: line(text, 'muted'), value: null }));
  // Threads that wait for the owner are counted on their row.
  for (const item of rows(items)) if (NEEDS_OWNER.includes(item.kind)) { const target = threadTarget(item, status); waiting.set(target, (waiting.get(target) ?? 0) + 1); }
  // Who is in a channel, by name: me first, then whoever is online, then the rest. Only people still on the team count.
  const cast = (team, keys) => {
    const here = rows(team.members).filter(m => keys.includes(m.key)), mates = here.filter(m => m.key !== status.key);
    return [...(mates.length < here.length ? [{ name: 'you', tone: 'blue' }] : []), ...[true, false].flatMap(on => mates.filter(m => Boolean(m.online) === on)).map(m => ({ name: peerName(m.name, m.key), tone: toneOf.get(m.key) ?? 'text' }))];
  };
  // A channel's row: its name, how many people are in it (muted), then the threads that wait for me. The name gives way on a narrow bar.
  const room = (team, channel, name, members) => {
    const target = roomTarget(team.id, channel), count = waiting.get(target), suffix = teams.length > 1 ? ` · ${remote(team.name, 30) || 'team'}` : '', who = cast(team, members), people = who.map(row => row.name), tones = who.map(row => row.tone);
    const size = `  ${people.length}`, wait = count ? `  ${count}` : '', head = fitWords(`# ${name}${suffix}`, Math.max(0, width - size.length - wait.length));
    bar.push({ line: `${ink(head, count ? 'orange' : 'text', colour, Boolean(count))}${ink(size, 'muted', colour)}${wait ? ink(wait, 'orange', colour, true) : ''}`, value: { type: 'room', target, team: team.id, channel, name, members, people, tones, waiting: count ?? 0 }, key: target });
  };
  bar.push({ line: line('Channels', 'muted', true), value: null });
  for (const team of teams) {
    room(team, null, 'general', rows(team.members).map(m => m.key));
    for (const channel of rows(team.channels)) room(team, channel.id, remote(channel.name, 30), Array.isArray(channel.members) ? channel.members : []);
  }
  bar.push({ line: line('+ Add channel', 'muted'), value: { type: 'add', what: 'channel' }, key: 'add\0channel' }, { line: '', value: null }, { line: line('Direct messages', 'muted', true), value: null });
  for (const team of teams) for (const member of rows(team.members)) if (member.key !== status.key && !people.has(member.key)) people.set(member.key, { member, team });
  for (const { member, team } of people.values()) {
    const target = dmTarget(member.key), count = waiting.get(target), state = member.online ? member.path ?? 'online' : 'offline', mark = trust.has(member.key) ? ' · trusted' : '';
    // The name is in the teammate's own colour; the dot and the state say whether they are here.
    const dot = `${member.online ? '●' : '○'} `, name = peerName(member.name, member.key).padEnd(14), tail = ` ${state}${mark}${count ? `  ${count}` : ''}`, tone = count ? 'orange' : member.online ? 'green' : 'muted';
    const drawn = `${dot}${name}${tail}`.length <= width ? `${ink(dot, tone, colour, Boolean(count))}${ink(name, toneOf.get(member.key) ?? 'text', colour, Boolean(count))}${ink(tail, tone, colour, Boolean(count))}` : line(`${dot}${name}${tail}`, tone, Boolean(count));
    bar.push({ line: drawn, value: { type: 'member', target, key: member.key, name: member.name, self: false, member, team, trusted: trust.has(member.key), waiting: count ?? 0 }, key: target });
  }
  // Bots: mine, then each teammate's shared ones with the name of the machine that runs them.
  const bot = (peer, row, member) => {
    if (!BOT.test(row.name ?? '')) return;
    const target = botTarget(peer, row.name), from = member ? ` · ${remote(member.box, 32) || peerName(member.name, member.key)}` : '';
    // My own bot shows in its colour (tone, set by the terminal); a teammate's is plain.
    bar.push({ line: line(`◆ @${row.name}${from}`, !member ? PALETTE[row.tone] ? row.tone : 'text' : member.online ? 'text' : 'muted'), value: { type: 'bot', target, name: row.name, peer, owner: member?.name ?? null, box: member?.box ?? null, about: remote(row.about, 120), online: member ? member.online === true : true }, key: target });
  };
  for (const row of rows(bots)) bot(null, row, null);
  for (const { member } of people.values()) for (const row of rows(member.bots).slice(0, 20)) bot(member.key, row, member);
  bar.push({ line: line('+ Add teammate', 'muted'), value: { type: 'add', what: 'teammate' }, key: 'add\0teammate' });
  return bar;
}
// The line over a channel's threads: who is in it, from its row in the bar, each name in
// that person's colour, then how someone gets in while there is room for it. Names that do
// not fit are counted as "+N more".
export function membersLine(room, width, colour = true) {
  const names = Array.isArray(room?.people) ? room.people : [], tones = Array.isArray(room?.tones) ? room.tones : [];
  const head = `In #${room?.name} · `, more = shown => shown < names.length ? `, +${names.length - shown} more` : '', text = shown => `${head}${names.slice(0, shown).join(', ') || 'nobody'}${more(shown)}`;
  let shown = names.length;
  while (shown > 1 && text(shown).length > width) shown--;
  if (text(shown).length > width) return ink(fitWords(text(shown), width), 'muted', colour);
  const how = room?.channel ? 'm changes who is in it' : '/invite adds a teammate', tail = text(shown).length + how.length + 3 <= width ? ` · ${how}` : '';
  const listed = names.slice(0, shown).map((name, at) => ink(name, tones[at] ?? 'text', colour)).join(ink(', ', 'muted', colour)) || ink('nobody', 'muted', colour);
  return `${ink(head, 'muted', colour)}${listed}${more(shown) || tail ? ink(`${more(shown)}${tail}`, 'muted', colour) : ''}`;
}
// trusted: the keys of teammates whose paths pass through. target: the bar
// row whose threads show (all of them without one); where: its name, for the empty pane.
export function teamPanes({ status, agents, items, trusted = [], bots = [] }, widths, colour, target = null, where = null) {
  const line = (index, text, tone, bold, trusted = false) => ink(fitWords(text, widths[index]), tone, colour, bold, { trusted });
  const team = chatBar({ status, items, trusted, bots }, widths[0], colour);
  const work = [];
  for (const mate of rows(agents)) {
    const who = peerName(mate.name, mate.peer), live = rows(mate.rows);
    if (!live.length) work.push({ line: line(1, `${mate.online ? '●' : '○'} ${who} no live sessions`, 'muted'), value: { type: 'agent', name: mate.name, peer: mate.peer, mate }, key: `${mate.peer}\0` });
    for (const row of live) {
      const overlap = Array.isArray(row.overlap) ? row.overlap.filter(file => typeof file === 'string') : [];
      const parts = [`${overlap.length ? '⚠' : '·'} ${who}`, remote(row.handle, 40), remote(row.label, 30)].filter(Boolean).join(' ');
      const text = [parts, overlap.length ? `overlap ${remote(overlap[0], 120)}${overlap.length > 1 ? ` +${overlap.length - 1}` : ''}` : '', remote(row.now, 80)].filter(Boolean).join(' · ');
      work.push({ line: line(1, text, overlap.length ? 'orange' : 'text', Boolean(overlap.length)), value: { type: 'agent', name: mate.name, peer: mate.peer, mate, row }, key: `${mate.peer}\0${row.handle}\0${row.taskId}` });
    }
  }
  if (!work.length) work.push({ line: line(1, 'No teammates’ sessions are live.', 'muted'), value: null });
  const toneOf = peopleTones(status);
  // A thread row: up to its first " · " it says who did what, and there a teammate's name is
  // in their colour and "you" in yours. The rest keeps the row's own tone.
  const said = (text, tone, bold, trusted, who, whoTone) => {
    const fitted = fitWords(text, widths[2]), at = fitted.indexOf(' · '), start = at < 0 ? fitted : fitted.slice(0, at), rest = at < 0 ? '' : fitted.slice(at);
    const names = [whoTone && who ? who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null, '\\byou\\b'].filter(Boolean).join('|');
    return start.split(new RegExp(`(${names})`)).filter(Boolean).map(part => ink(part, whoTone && part === who ? whoTone : part === 'you' ? 'blue' : tone, colour, bold, { trusted })).join('') + (rest ? ink(rest, tone, colour, bold, { trusted }) : '');
  };
  // Like a chat: each message on its own row, the reply (or what it waits on) indented under it.
  const threads = rows(items).filter(item => THREAD[item.kind] && (!target || threadTarget(item, status) === target)).sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)).flatMap(item => {
    const value = { type: 'thread', ...item }, who = threadWho(item), [message, reply] = threadRows(item, who), trusted = item.trusted === true, whoTone = toneOf.get(item.peer) ?? null;
    return [
      { line: said(message[0], message[1], NEEDS_OWNER.includes(item.kind), trusted, who, whoTone), value, key: String(item.id) },
      ...(reply ? [{ line: said(`   ↳ ${reply[0]}`, reply[1], item.kind === 'held', trusted, who, whoTone), value, key: `${item.id}\0reply` }] : []),
    ];
  });
  if (!threads.length) {
    // An empty channel also says who is in it and how that changes. Sentences share a row while they fit.
    const open = team.find(row => row.value?.target === target)?.value, room = open?.type === 'room' ? open : null;
    const says = !where ? ['No team yet. The Team list on the left says how to invite someone, or join with a code.'] : [`Nothing in ${where} yet.`, ...(
      !room ? ['Type below to write to it.']
      : room.channel ? ['Type below to write to it.', 'm changes who is in it.']
      : room.people.length < 2 ? ['Nobody else is on the team yet.', '+ Add teammate invites someone.']
      : ['Everyone on the team is in it.', 'Type below to write to it.'])];
    const fitted = says.reduce((out, text) => out.length && `${out.at(-1)} ${text}`.length <= widths[2] ? [...out.slice(0, -1), `${out.at(-1)} ${text}`] : [...out, text], []);
    threads.push(...fitted.map(text => ({ line: line(2, text, 'muted'), value: null })));
  }
  return [team, work, threads];
}
// "2 online" counts each teammate once across teams, never this machine.
export function peerSummary(on, status) {
  if (!on) return 'peers off';
  if (status && status.running === false) return 'peers stopped';
  const online = new Set(rows(status?.teams).flatMap(team => rows(team.members)).filter(member => member.online && member.key !== status?.key).map(member => member.key));
  return `${online.size} online`;
}

// Chat messages. Text is wrapped here, not by the box, so the speaker's bar runs down every row.
const columns = value => blessed.unicode.strWidth(value);
const escapeTags = value => value.replace(/[{}]/g, ch => ch === '{' ? '{open}' : '{close}');
// Word wrap to width columns. List items (-, *, 1.) keep their indent on the rows that follow.
export function wrapText(text, width) {
  width = Math.max(8, width);
  const out = [];
  for (const source of String(text ?? '').split('\n')) {
    const line = source.replace(/\s+$/, '');
    if (!line) { out.push(''); continue; }
    const marker = /^\s*(?:[-*•]|\d+[.)])\s+/.exec(line)?.[0] ?? /^\s*/.exec(line)[0];
    const indent = ' '.repeat(Math.min(columns(marker), Math.floor(width / 2)));
    let rest = line, first = true;
    while (rest) {
      const lead = first ? '' : indent, room = width - columns(lead);
      if (columns(rest) <= room) { out.push(lead + rest); break; }
      let piece = '', used = 0;
      for (const ch of rest) { const size = columns(ch); if (used + size > room) break; piece += ch; used += size; }
      if (!piece) piece = Array.from(rest)[0];
      const space = piece.lastIndexOf(' ');
      if (space > 0 && rest[piece.length] !== ' ') piece = piece.slice(0, space);
      out.push(lead + piece.replace(/\s+$/, ''));
      rest = rest.slice(piece.length).replace(/^\s+/, ''); first = false;
    }
  }
  return out;
}
// A header (speaker and time), then the text behind a bar in the speaker's colour. Shaded
// messages (yours) sit on a band the width of the pane.
export function chatBlock({ title, time = '', text, tone, shaded = false, width, colour = true }) {
  const header = ink(title, tone, colour, true) + (time ? `  ${ink(time, 'muted', colour)}` : '');
  const room = Math.max(10, width), rows = wrapText(text, room - 2);
  const band = shaded && colour ? `{${PALETTE.raised}-bg}` : '', bar = colour ? `{${PALETTE[tone]}-fg}┃{/}` : '┃';
  const body = rows.map(row => {
    const fill = band ? ' '.repeat(Math.max(0, room - 2 - columns(row))) : '';
    return `${band}${bar}${band} ${escapeTags(row)}${fill}${band ? '{/}' : ''}`;
  });
  return [header, ...body].join('\n');
}
export function messageTime(value, now = new Date()) {
  const at = new Date(value); if (!Number.isFinite(at.getTime())) return '';
  const clock = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? clock : `${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${clock}`;
}
