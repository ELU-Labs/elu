import blessed from 'blessed';
import { redact } from './publish.mjs';
import { sanitize } from './peer/peerdata.mjs';
import { columns, cut, head, padEnd, unitAt, unitWidth } from './width.mjs';
import './terminal-cells.mjs';
import { reachText } from './peer/reach-text.mjs';

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
    if (columns(visible([...shown, text].join('  '))) > width) break;
    shown.push(text);
  }
  // A first hint wider than the bar, such as a long command's usage, is cut to fit rather than left out.
  if (!shown.length && pairs.length && width > 1) {
    const [key, label] = pairs[0], first = cut(String(key), width), room = width - columns(first) - 1;
    return ink(first, 'text', colour, true) + (room > 3 ? ` ${ink(cut(String(label), room), 'muted', colour)}` : '');
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
  if (columns(text) <= width) return text;
  if (width < 2) return head(text, width);
  const start = head(text, width - 1), space = start.lastIndexOf(' ');
  return `${(space > 0 ? start.slice(0, space) : start).trimEnd()}…`;
}
export const clockTime = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '--:--';
const rows = value => Array.isArray(value) ? value.filter(row => row && typeof row === 'object') : [];
// How long a message has waited to go out, in a few characters: 40s, 3m, 2h, 1d.
const waitedText = ms => { const seconds = Math.floor(ms / 1000); return !Number.isFinite(seconds) || seconds < 5 ? '' : seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`; };
// Where a message of mine to a teammate, or to another computer of mine, is now. text: the
// line under the chat after it is sent; short: its reply row in the thread; done: nothing
// more will change. item: its row from the daemon (peerItems). who: the @name it shows
// under. online: the roster shows that computer connected. mine: it is another computer of
// mine; unconfirmed: this machine's name, while that computer has not marked this one back
// (a delivered message then says what ends that wait). A message that is not there yet says
// why: that computer is not connected, for how long, and that it goes as soon as it connects.
export function sentState(item, { who = '', online = false, mine = false, unconfirmed = null, now = Date.now() } = {}) {
  if (!item || typeof item !== 'object') return null;
  const trusted = item.trusted === true, said = value => remote(value, 400, { trusted }), connects = mine ? 'it connects' : 'they connect';
  if (item.kind === 'answer') return { text: `${who} answered. The reply is in Chats.`, short: 'answered', done: true };
  if (item.kind === 'expired') return { text: `Your message to ${who} was not delivered in a week and is no longer sent.`, short: 'expired', done: true };
  if (item.kind === 'rejected') return item.state === 'failed' ? { text: `Failed on ${who}: ${said(item.text)}`, short: `failed · ${said(item.text)}`, done: true } : { text: `${who} declined it${item.text && item.text !== item.question ? `: ${said(item.text)}` : '.'}`, short: `rejected · ${said(item.text)}`, done: true };
  if (item.kind !== 'asked') return null;
  const state = remote(item.state, 30), note = item.note ? said(item.note) : '';
  if (state === 'pending') {
    const waited = waitedText(now - Date.parse(item.at)), time = waited ? ` (${waited})` : '';
    return online ? { text: `Not delivered to ${who} yet${time}. It is sent again by itself.`, short: `not delivered yet${time}`, late: true }
      : { text: `${who} is offline${time}. Your message goes as soon as ${connects}.`, short: `not connected to ${who} yet${time} · it goes as soon as ${connects}`, late: true };
  }
  if (state === 'submitted') { const at = Number.isFinite(Date.parse(item.deliveredAt)) ? ` at ${clockTime(item.deliveredAt)}` : '', agree = unconfirmed ? ` Waiting for ${who} to agree: run /mine @${unconfirmed} there.` : ''; return { text: `Delivered to ${who}${at}.${note ? ` ${note}` : ''}${agree}`, short: `delivered${at}${note ? ` · ${note}` : ''}` }; }
  if (state === 'working' && item.startedAs) { const name = said(item.startedAs); return { text: `Started on ${who} as session "${name}".`, short: `started there as session "${name}"` }; }
  if (state === 'working') return { text: `${who} is working on it.`, short: 'working' };
  if (state === 'held') return { text: `${who} has a reply that waits there to be sent.`, short: 'held' };
  return { text: `Sent to ${who}.`, short: state || 'sent' };
}
const THREAD = { answering: ['←', 'asks you', 'text'], replied: ['→', 'replied', 'green'], failed: ['←', 'asks you', 'muted'], declined: ['←', 'asks you', 'muted'], incoming: ['←', 'asks you', 'orange'], held: ['→', 'reply ready', 'orange'], draft: ['→', 'draft to send', 'orange'], asked: ['→', 'asked', 'text'], answer: ['←', 'answered', 'green'], expired: ['→', 'expired', 'muted'], rejected: ['→', 'rejected', 'muted'] };
const NEEDS_OWNER = ['incoming', 'held', 'draft'];
// A bot's name, and the kinds of thread I started (the rest are a teammate's requests to me).
const BOT = /^[a-z][a-z0-9-]{0,29}$/, MINE = ['asked', 'answer', 'expired', 'rejected'];
// [message, reply]: each [text, tone]. A teammate's question shows my side under it; my
// question shows theirs. The question is item.question when item.text holds the reply.
function threadRows(item, who, where = {}) {
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
    answering: ['your model is answering…', 'muted'], failed: item.reason || item.why ? [`your model could not answer · ${remote(item.reason || item.why, 400, { trusted: true })}`, 'orange'] : ['your model could not answer', 'muted'], declined: ['you declined', 'muted'],
    held: [`${item.result ? 'result' : 'reply'} ready${item.blocked ? ', held: possible secret' : ''} · ${text}`, 'orange'], replied: [`you replied · ${text}`, 'green'],
    asked: (sent => pictures?.unsent ? [`${sent.short} · ${remote(pictures.unsent, 300)}`, 'orange'] : [sent.short, sent.late ? 'orange' : 'muted'])(sentState({ ...item, kind: 'asked', ...(pictures?.unsent ? { note: null } : {}) }, { who, ...where })), answer: [`${item.result ? `result from ${bot ?? who}` : `${bot ?? who} answered`}${item.continued === true ? ' · continued in your session' : ''} · ${text}`, item.continued === true ? 'muted' : 'green'],
    expired: ['expired', 'muted'], rejected: [`rejected · ${text}`, 'muted'],
  }[item.kind] ?? null;
  // A message of mine that failed there says so, with why and the one thing to do; one that
  // waits there says what it waits for. Both are read whole (wraps).
  if (item.kind === 'rejected' && item.state === 'failed') return [message, [`failed · ${text}`, 'orange']];
  return [message, reply];
}
// The reply row of a message of mine that got no answer, or still waits for one, is its
// reason: it wraps onto the rows under it, up to four, instead of being cut at the edge.
const wraps = item => item.kind === 'rejected' || item.kind === 'failed' && Boolean(item.reason || item.why) || item.kind === 'asked' && (Boolean(item.note) || item.state === 'pending' || Boolean(item.startedAs));
function replyRows(item, text, width) {
  if (!wraps(item) || columns(text) + 5 <= width) return [`   ↳ ${text}`];
  const rows = wrapText(`↳ ${text}`, Math.max(12, width - 5)), shown = rows.slice(0, 4);
  if (rows.length > 4) shown[3] = fitWords(rows.slice(3).join(' '), Math.max(12, width - 5));
  return shown.map((row, index) => `${index ? '     ' : '   '}${row}`);
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
// What the Team list says before there is a team: how to invite, and how to join.
export const NO_TEAM = 'No team yet. Invite someone: /invite\nGot a code? /join CODE';
// The columns a teammate's name keeps on its row when the row is too narrow for it and how they are reached.
const NAME_ROOM = [12, 6];
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
    const size = `  ${people.length}`, wait = count ? `  ${count}` : '', title = fitWords(`# ${name}${suffix}`, Math.max(0, width - size.length - wait.length));
    bar.push({ line: `${ink(title, count ? 'orange' : 'text', colour, Boolean(count))}${ink(size, 'muted', colour)}${wait ? ink(wait, 'orange', colour, true) : ''}`, value: { type: 'room', target, team: team.id, channel, name, members, people, tones, waiting: count ?? 0 }, key: target });
  };
  bar.push({ line: line('Channels', 'muted', true), value: null });
  for (const team of teams) {
    room(team, null, 'general', rows(team.members).map(m => m.key));
    for (const channel of rows(team.channels)) room(team, channel.id, remote(channel.name, 30), Array.isArray(channel.members) ? channel.members : []);
  }
  bar.push({ line: line('+ Add channel', 'muted'), value: { type: 'add', what: 'channel' }, key: 'add\0channel' }, { line: '', value: null }, { line: line('Direct messages', 'muted', true), value: null });
  for (const team of teams) for (const member of rows(team.members)) if (member.key !== status.key && !people.has(member.key)) people.set(member.key, { member, team });
  for (const { member, team } of people.values()) {
    const target = dmTarget(member.key), count = waiting.get(target), reached = { ...member, via: remote(member.via, 60) }, mark = `${trust.has(member.key) ? ' · trusted' : ''}${count ? `  ${count}` : ''}`;
    // The name is in the teammate's own colour; the dot and the state say whether they are here.
    const dot = `${member.online ? '●' : '○'} `, shown = peerName(member.name, member.key), padded = padEnd(shown, 14), tone = count ? 'orange' : member.online ? 'green' : 'muted';
    // Another computer of mine (mine, set by the app) says yours first. One that has not marked this one back yet (waiting) says that instead: it is not mine yet. It names whose agreement it waits for and, where there is room, what to type there (self: the name /mine there finds this machine by), in fewer words where the bar is narrow. While it is offline it says so first.
    // A teammate's computer that marked this one as its own, and that this one has not marked (asks: the name /mine here finds it by), says so; Enter on it agrees.
    const yours = member.mine === true ? 'yours · ' : '', fits = (name, state) => columns(`${dot}${name} ${state}${mark}`) <= width;
    const self = remote(member.self, 40).replace(/[\s@]+/g, ''), asks = member.mine !== true ? remote(member.asks, 40).replace(/[\s@]+/g, '') : '', off = member.online ? '' : 'offline · ';
    // One that another computer of mine marked here, on an ELU that cannot take that (older), says to update it.
    const forms = member.mine === true && member.waiting === true ? (member.older === true ? [`update ELU on ${shown}`, 'update ELU there'] : member.online ? [`waiting for ${shown} to agree${self ? ` · run /mine @${self} there` : ''}`, `waiting for ${shown} to agree`, 'waiting for it to agree', 'not agreed yet'] : [`offline · waiting for ${shown} to agree`, 'offline · not agreed yet'])
      : asks ? [`${off}says it is yours`, 'says it is yours'] : null;
    // The longest wording that fits, beside the name in its column or else beside the name alone; else the shortest.
    const agreeing = forms && forms.find(text => fits(padded, text) || fits(shown, text)), unconfirmed = forms ? agreeing ?? forms.at(-1) : null;
    // A state too long for the row, as one that names the computer it goes through, takes the
    // room the name's column leaves empty, and then the longest wording that fits.
    const roomy = unconfirmed !== null ? fits(padded, unconfirmed) || !agreeing : fits(padded, `${yours}${reachText(reached)}`), fit = named => width - columns(dot) - named - 1 - columns(mark) - columns(yours);
    let name = roomy ? padded : shown, state = unconfirmed ?? `${yours}${reachText(reached, roomy ? {} : { fit: fit(columns(shown)) })}`;
    // A long name gives way before the state: the state takes the room a name of 12 columns
    // leaves (6 where even that is too little), in the longest words that fit there, and the
    // name is cut to what is left.
    if (!fits(name, state) && columns(shown) > NAME_ROOM[0]) {
      const kept = NAME_ROOM.find(room => columns(reachText(reached, { fit: fit(room) })) <= fit(room)) ?? NAME_ROOM.at(-1);
      state = unconfirmed ?? `${yours}${reachText(reached, { fit: fit(kept) })}`;
      name = fitWords(shown, Math.max(kept, width - columns(dot) - 1 - columns(state) - columns(mark)));
    }
    const tail = ` ${state}${mark}`;
    const drawn = columns(`${dot}${name}${tail}`) <= width ? `${ink(dot, tone, colour, Boolean(count))}${ink(name, toneOf.get(member.key) ?? 'text', colour, Boolean(count))}${ink(tail, tone, colour, Boolean(count))}` : line(`${dot}${name}${tail}`, tone, Boolean(count));
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
  const lead = `In #${room?.name} · `, more = shown => shown < names.length ? `, +${names.length - shown} more` : '', text = shown => `${lead}${names.slice(0, shown).join(', ') || 'nobody'}${more(shown)}`;
  let shown = names.length;
  while (shown > 1 && columns(text(shown)) > width) shown--;
  if (columns(text(shown)) > width) return ink(fitWords(text(shown), width), 'muted', colour);
  const how = room?.channel ? 'm changes who is in it' : '/invite adds a teammate', tail = columns(text(shown)) + columns(how) + 3 <= width ? ` · ${how}` : '';
  const listed = names.slice(0, shown).map((name, at) => ink(name, tones[at] ?? 'text', colour)).join(ink(', ', 'muted', colour)) || ink('nobody', 'muted', colour);
  return `${ink(lead, 'muted', colour)}${listed}${more(shown) || tail ? ink(`${more(shown)}${tail}`, 'muted', colour) : ''}`;
}
// The line over a teammate's threads: what is on for them, then the keys that change it
// while there is room. policy: mine about them (lib/peer/settings.mjs). Hold replies: each
// reply and result to them waits for me. Auto-continue: their answer or result continues the
// chat I asked from.
export function teammateLine(policy, width, colour = true) {
  const parts = [['Hold replies', policy?.holdReplies === true], ['Auto-continue', policy?.autoContinue === true]], how = ' · h and o change them';
  const plain = parts.map(([label, on]) => `${label}: ${on ? 'on' : 'off'}`).join(' · ');
  if (columns(plain) > width) return ink(fitWords(plain, width), 'muted', colour);
  const shown = parts.map(([label, on]) => `${ink(`${label}: `, 'muted', colour)}${ink(on ? 'on' : 'off', on ? 'orange' : 'muted', colour, on)}`).join(ink(' · ', 'muted', colour));
  return `${shown}${columns(plain) + columns(how) <= width ? ink(how, 'muted', colour) : ''}`;
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
  // Who the roster shows connected, and which of them are my own computers: a message of mine that has not gone out yet says why.
  const members = rows(status?.teams).flatMap(team => rows(team.members)), here = new Set(members.filter(member => member.online).map(member => member.key)), mine = new Set(members.filter(member => member.mine === true).map(member => member.key));
  // Like a chat: each message on its own row, the reply (or what it waits on) indented under it.
  const threads = rows(items).filter(item => THREAD[item.kind] && (!target || threadTarget(item, status) === target)).sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)).flatMap(item => {
    const value = { type: 'thread', ...item }, who = threadWho(item), [message, reply] = threadRows(item, who, { online: here.has(item.peer), mine: mine.has(item.peer) }), trusted = item.trusted === true, whoTone = toneOf.get(item.peer) ?? null;
    return [
      { line: said(message[0], message[1], NEEDS_OWNER.includes(item.kind), trusted, who, whoTone), value, key: String(item.id) },
      ...(reply ? replyRows(item, reply[0], widths[2]).map((text, index) => ({ line: said(text, reply[1], item.kind === 'held', trusted, who, whoTone), value, key: index ? `${item.id}\0reply\0${index}` : `${item.id}\0reply` })) : []),
    ];
  });
  if (!threads.length) {
    // An empty channel also says who is in it and how that changes. Sentences share a row while they fit.
    const open = team.find(row => row.value?.target === target)?.value, room = open?.type === 'room' ? open : null;
    const says = !where ? ['No team yet. Invite someone with /invite, or join with /join CODE.'] : [`Nothing in ${where} yet.`, ...(
      !room ? ['Type below to write to it.']
      : room.channel ? ['Type below to write to it.', 'm changes who is in it.']
      : room.people.length < 2 ? ['Nobody else is on the team yet.', '+ Add teammate invites someone.']
      : ['Everyone on the team is in it.', 'Type below to write to it.'])];
    const fitted = says.reduce((out, text) => out.length && columns(`${out.at(-1)} ${text}`) <= widths[2] ? [...out.slice(0, -1), `${out.at(-1)} ${text}`] : [...out, text], []);
    threads.push(...fitted.map(text => ({ line: line(2, text, 'muted'), value: null })));
  }
  return [team, work, threads];
}
// "2 online" counts each teammate once across teams, never this machine.
export function peerSummary(on, status) {
  if (!on) return 'no team';
  if (status && status.running === false) return 'peers stopped';
  const online = new Set(rows(status?.teams).flatMap(team => rows(team.members)).filter(member => member.online && member.key !== status?.key).map(member => member.key));
  return `${online.size} online`;
}

// Chat messages. Text is wrapped here, not by the box, so the speaker's bar runs down every row.
const escapeTags = value => value.replace(/[{}]/g, ch => ch === '{' ? '{open}' : '{close}');
// A command the owner copies is never broken across rows: a row with no room for all of it
// ends before it. These are the vendors' sign-in commands and elu's own, with what follows them.
const COMMAND = /\b(?:(?:codex|grok|agy) login|claude auth login|elu [a-z]+)(?: (?:--[a-z][a-z-]*|@[\w-]+|[A-Z]{2,}\b))*/g, JOINED = '\u00a0';
// Word wrap to width columns. List items (-, *, 1.) keep their indent on the rows that follow.
// A line is walked once, from at: each row measures only the characters it takes, so one
// line of a megabyte (a pasted log, minified JSON) wraps as fast as the same text in many lines.
export function wrapText(text, width) {
  width = Math.max(8, width);
  const out = [];
  for (const source of String(text ?? '').split('\n')) {
    const line = source.replace(/\s+$/, '').replace(COMMAND, command => command.replaceAll(' ', JOINED));
    if (!line) { out.push(''); continue; }
    const marker = /^\s*(?:[-*•]|\d+[.)])\s+/.exec(line)?.[0] ?? /^\s*/.exec(line)[0];
    const indent = ' '.repeat(Math.min(columns(marker), Math.floor(width / 2)));
    let at = 0, first = true;
    while (at < line.length) {
      const lead = first ? '' : indent, room = width - columns(lead);
      // end: one past the last character (lib/width.mjs) that fits on this row.
      let end = at, used = 0;
      while (end < line.length) {
        const unit = unitAt(line, end) || line[end], size = unitWidth(unit);
        if (used + size > room) break;
        end += unit.length; used += size;
      }
      if (end >= line.length) { out.push((lead + line.slice(at)).replaceAll(JOINED, ' ')); break; }
      // Not even one character fits: it takes a row of its own.
      if (end === at) end = at + (unitAt(line, at).length || 1);
      let piece = line.slice(at, end);
      const space = piece.lastIndexOf(' ');
      if (space > 0 && line[end] !== ' ') piece = piece.slice(0, space);
      out.push((lead + piece.replace(/\s+$/, '')).replaceAll(JOINED, ' '));
      at += piece.length; while (at < line.length && /\s/.test(line[at])) at += 1;
      first = false;
    }
  }
  return out;
}
// A header's title with the model and effort that wrote the message in parentheses after the
// speaker's name, before what follows it (on @devbox, is waiting for you): "@lead (fable 5.2
// med) on @devbox". narrow is the same title without them, for a pane too narrow for both.
export function tagged(name, tag = null, after = '') {
  return tag ? { title: `${name} (${tag})${after}`, narrow: `${name}${after}` } : { title: `${name}${after}` };
}
// A header (speaker and time), then the text behind a bar in the speaker's colour. Shaded
// messages (yours) sit on a band the width of the pane. A header that does not fit on one row
// with its time shows narrow, its title without the parentheses, when it has one.
export function chatBlock({ title, narrow = null, time = '', text, tone, shaded = false, width, colour = true }) {
  const room = Math.max(10, width), fits = columns(title) + (time ? 2 + columns(time) : 0) <= room;
  const header = ink(narrow && !fits ? narrow : title, tone, colour, true) + (time ? `  ${ink(time, 'muted', colour)}` : '');
  const rows = wrapText(text, room - 2);
  const band = shaded && colour ? `{${PALETTE.raised}-bg}` : '', bar = colour ? `{${PALETTE[tone]}-fg}┃{/}` : '┃';
  const body = rows.map(row => {
    const fill = band ? ' '.repeat(Math.max(0, room - 2 - columns(row))) : '';
    return `${band}${bar}${band} ${escapeTags(row)}${fill}${band ? '{/}' : ''}`;
  });
  return [header, ...body].join('\n');
}
// A pane that shows rows the app wrapped keeps each one whole. blessed counts a row in units
// of the string, not in cells: it wraps a coloured row that fills the pane a second time, at
// its last space, and an emoji is two units more than its cells. The last word landed on a
// row of its own, without the speaker's bar. Here a row that fits the pane is one row again.
// Given the screen, it keeps the rows of every pane put on it, now or later: a list's rows
// are one line high, so there the last word was not shown at all, and a pane that does not
// wrap (the Changes view) cut such a row short of its last columns.
// A row wider than its pane is wrapped, or cut where the pane does not wrap, here too: by
// cells and between two characters, where blessed could cut one in half.
const bare = row => row.replace(/\x1b\[[\d;]*m/g, '');
const paneCells = row => { let cells = 0; for (const ch of bare(row)) if (!blessed.unicode.combining[ch.codePointAt(0)]) cells++; return cells; };
const CODE = /\x1b\[[\d;]*m/y;
function cellRows(line, room, wrap) {
  const rows = []; let row = '', used = 0, gap = 0;
  for (let at = 0; at < line.length;) {
    CODE.lastIndex = at; const code = CODE.exec(line)?.[0];
    if (code) { row += code; at += code.length; continue; }
    // One character as blessed holds it: a code point, the marks on it, the cell for its second column.
    let end = at + (line.codePointAt(at) > 0xffff ? 2 : 1);
    while (end < line.length && blessed.unicode.combining[line.codePointAt(end)]) end += line.codePointAt(end) > 0xffff ? 2 : 1;
    const size = line[end] === '\x03' ? 2 : 1; end += size - 1;
    if (used + size > room && used) {
      if (!wrap) return [row + (line.slice(at).match(/\x1b\[[\d;]*m/g) ?? []).join('')];
      rows.push(gap ? row.slice(0, gap) : row); row = gap ? row.slice(gap) : ''; used = paneCells(row); gap = 0;
    }
    row += line.slice(at, end); used += size; at = end;
    if (row.endsWith(' ')) gap = row.length;
  }
  return [...rows, row];
}
export function keepRows(box) {
  if (box.type === 'screen') { box.on('adopt', keepRows); box.on('element adopt', (_, pane) => keepRows(pane)); return box; }
  if (Object.hasOwn(box, '_wrapContent')) return box;
  const wrap = box._wrapContent;
  box._wrapContent = function (content, width) {
    const rows = wrap.call(this, content, width), margin = (this.scrollbar ? 1 : 0) + (this.type === 'textarea' ? 1 : 0), room = width > margin ? width - margin : width;
    const out = [], rtof = [], ftor = [];
    rows.fake.forEach((line, no) => {
      const parts = rows.ftor[no].map(at => rows[at]);
      // Wrapped again: the parts are the line. Cut short: the one part is where the line starts.
      // Anything else is a row blessed moved to line it up, which stays as blessed made it.
      const broken = parts.length > 1 ? parts.join('') === line : !this.wrap && parts[0] !== line && bare(line).startsWith(bare(parts[0]));
      const kept = !broken ? parts : paneCells(line) <= room ? [line] : cellRows(line, room, this.wrap);
      ftor.push(kept.map((_, at) => out.length + at));
      for (const row of kept) { out.push(row); rtof.push(no); }
    });
    return Object.assign(out, { rtof, ftor, fake: rows.fake, real: out, mwidth: out.reduce((most, row) => Math.max(most, paneCells(row)), 0) });
  };
  for (const pane of box.children) keepRows(pane);
  return box;
}
export function messageTime(value, now = new Date()) {
  const at = new Date(value); if (!Number.isFinite(at.getTime())) return '';
  const clock = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? clock : `${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${clock}`;
}
// What a model did while it worked (lib/run-activity.mjs), one step under another: a thought
// muted after ✻, a tool call after how it went (● still running, ✓ done, ✗ failed), its plan,
// and what it wrote on the way after •. A step wraps under its first word, and a helper
// agent's steps sit two columns in. width: the columns the lines may take.
// A call says how long it has run so far, counted from now (ms), or how long it ran; one the
// run's end cut (■) says it was stopped. A thought with no text says how many tokens it took.
// The last line may be the commands the run has in the background, and for how long.
const STEP_MARK = { running: ['●', 'orange'], ok: ['✓', 'green'], failed: ['✗', 'red'], stopped: ['■', 'muted'] };
const PLAN_MARK = { done: ['✓', 'green'], doing: ['●', 'orange'], todo: ['○', 'muted'] };
// A thought or text reads as words: its **headings** without the stars, no empty lines.
const prose = value => String(value ?? '').replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/\n[ \t]*(?:\n[ \t]*)+/g, '\n');
// A time under two seconds is not said: most calls end at once.
const ran = seconds => Number.isFinite(seconds) && seconds >= 2 ? workedFor(Math.floor(seconds)) : null;
const tokenCount = count => count < 1000 ? String(count) : count < 100000 ? `${(count / 1000).toFixed(1)}k` : `${Math.round(count / 1000)}k`;
export function stepLines(steps, { width, colour = true, now = Date.now() }) {
  const out = [], going = since => ran(Number.isFinite(since) ? (now - since) / 1000 : NaN);
  const put = (indent, [mark, markTone], body, tone) => {
    const rows = wrapText(body, Math.max(8, width - columns(indent) - 2));
    rows.forEach((row, at) => out.push(`${indent}${at === 0 ? `${ink(mark, markTone, colour)} ` : '  '}${ink(row, tone, colour)}`));
  };
  for (const step of steps ?? []) {
    const indent = step.sub ? '  ' : '';
    if (step.kind === 'thinking') put(indent, ['✻', 'muted'], step.text || !step.tokens ? prose(step.text) : `${step.live ? 'thinking' : 'thought'} · ${tokenCount(step.tokens)} tokens`, 'muted');
    else if (step.kind === 'tool') {
      const took = step.status === 'running' ? going(step.since) : ran(step.seconds);
      put(indent, STEP_MARK[step.status] ?? STEP_MARK.running, [step.text, step.note, step.status === 'stopped' ? took ? `stopped after ${took}` : 'stopped' : took].filter(Boolean).join(' · '), 'text');
    }
    else if (step.kind === 'background') put(indent, STEP_MARK.running, [`${step.count} background ${step.tasks ? 'task' : 'command'}${step.count === 1 ? '' : 's'}${step.text ? `: ${step.text}` : ''}`, going(step.since)].filter(Boolean).join(' · '), 'text');
    else if (step.kind === 'plan') { put(indent, ['•', 'muted'], 'Plan', 'muted'); for (const entry of step.entries ?? []) put(`${indent}  `, PLAN_MARK[entry.state] ?? PLAN_MARK.todo, entry.text, entry.state === 'done' ? 'muted' : 'text'); }
    else put(indent, ['•', 'muted'], prose(step.text), 'text');
  }
  return out.join('\n');
}
// How long a turn worked, as a person says it: 42s, 3m 5s, 1h 4m.
export function workedFor(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
// A run whose program prints only when it ends has no steps to show while it works: one line
// counts the time since it started (ms) and says so, so the chat never shows "working" alone.
// name: the program, as the owner knows it.
export function silentLine(name, since, now = Date.now()) {
  const took = Number.isFinite(since) ? workedFor(Math.max(0, Math.floor((now - since) / 1000))) : null;
  return `${took ? `${took} so far. ` : ''}${name || 'This program'} reports only when it ends.`;
}
// The one line a finished turn's steps fold into, above its reply: ▸ shows them, ▾ hides them.
export const STEPS_LINE = /^[▸▾] \d+ steps? /;
// stopped: the owner stopped the turn before it replied.
export function stepsLine(count, seconds, open, colour = true, { stopped = false } = {}) {
  const took = workedFor(seconds);
  return ink(`${open ? '▾' : '▸'} ${count} step${count === 1 ? '' : 's'}${took ? ` in ${took}` : ''}${stopped ? ' · stopped' : ''} · ctrl+o ${open ? 'hides' : 'shows'} ${count === 1 ? 'it' : 'them'}`, 'muted', colour);
}
