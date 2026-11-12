import { remoteRow } from './board.mjs';
import { taskCard } from './terminal-plan.mjs';
import { remote, wrapText } from './terminal-visuals.mjs';

// The app's side of sessions on your other computers (lib/peer/remote.mjs): the rows they
// add to Sessions, what shows beside the list when one is under the cursor, the keys that
// act on one, and /mine. Everything it reads comes from the peer facade's files; everything
// it does goes to the daemon as a command. deps are the app's own helpers, passed in so this
// file draws as the rest of the app does.
export const MINE_USAGE = '/mine [@name | remove @name]';
const plainName = value => remote(value, 40).replace(/[\s@]+/g, '');
export function remoteSessions({ facade, peerRead, peerCommand, chatMessage, ink, colour, toneOfBot = () => 'violet' }) {
  const list = (name, ...args) => { try { const value = facade?.[name]?.(...args); return Array.isArray(value) ? value : []; } catch { return []; } };
  // Every teammate's machine, with the name it goes by here: its box name, else its owner's name.
  const machines = () => {
    const status = peerRead('peerStatus'), seen = new Map();
    for (const member of (status?.teams ?? []).flatMap(team => team?.members ?? [])) if (member?.key && member.key !== status.key && !seen.has(member.key)) seen.set(member.key, { key: member.key, name: plainName(member.box) || plainName(member.name) || member.key.slice(0, 8), owner: plainName(member.name), box: plainName(member.box), online: Boolean(member.online) });
    return seen;
  };
  const marks = () => new Map(list('mineRows').map(row => [row.key, row]));
  const nameOf = key => machines().get(key)?.name ?? key.slice(0, 8);
  // The machine a leading @word names, by its box name or its owner's name, any case.
  const find = (word, rows = [...machines().values()]) => {
    if (!/^@[^\s@]+$/.test(word ?? '')) return null;
    const wanted = word.slice(1).toLowerCase(), by = field => rows.filter(row => row[field] && row[field].toLowerCase() === wanted);
    const box = by('box'), owner = by('owner');
    return box.length === 1 ? box[0] : owner.length === 1 ? owner[0] : null;
  };
  // A machine this one marked as its own: a leading @name for it starts the session there.
  // One the other side has not marked back yet, or that runs an older build, is still found
  // here, so the owner hears why it cannot start, and the message never goes as a question.
  const named = word => { const marked = marks(); return find(word, [...machines().values()].filter(row => marked.get(row.key)?.mine)); };
  // Read from their files at most every 500 ms: the list is drawn far more often.
  let read = { at: 0, views: [] };
  const rows = (now = Date.now()) => { if (now - read.at > 500 || now < read.at) read = { at: now, views: list('remoteSessions') }; return read.views.map(view => remoteRow(view, nameOf(view.machine), now)); };
  const note = (text, tone, width) => wrapText(text, width).map(row => ink(row, tone, colour)).join('\n');
  // What shows beside the list for a session on another computer: its chat as a local
  // session shows it, the steps it is taking while it works, its changes, its Task and what
  // it waits for.
  function view(row, width) {
    const v = row.remote, where = `on @${row.machine}`, lines = [];
    const entries = v.entries?.length ? v.entries : v.text ? [{ role: 'You', at: v.createdAt, text: v.text }] : [];
    for (const entry of [...entries].sort((a, b) => Date.parse(a.at ?? 0) - Date.parse(b.at ?? 0))) {
      if (entry.shell) lines.push(chatMessage({ title: entry.role, at: entry.at, text: entry.text, tone: 'green', raw: true }, width, colour));
      else if (entry.bot) lines.push(chatMessage({ title: entry.role, at: entry.at, text: entry.text, tone: entry.failed ? 'red' : entry.quiet ? 'muted' : toneOfBot(entry.bot) }, width, colour));
      else lines.push(chatMessage({ title: entry.role, at: entry.at, text: entry.text, tone: entry.lead ? 'orange' : 'blue', shaded: !entry.lead }, width, colour));
    }
    if (v.state === 'needs_input' && v.question) lines.push(chatMessage({ title: 'Waiting for you', text: [v.question, (v.choices ?? []).map((choice, index) => `${index + 1}. ${choice}`).join('\n')].filter(Boolean).join('\n\n'), tone: 'orange' }, width, colour));
    if (v.diff?.patch) lines.push(chatMessage({ title: `Changes · ${v.diff.summary}`, text: v.diff.patch.split('\n').slice(0, 120).join('\n') + (v.diff.patch.split('\n').length > 120 ? '\n…' : ''), tone: 'green', raw: true }, width, colour));
    if (['starting', 'preparing', 'running'].includes(v.state) && !v.approvals?.length) {
      lines.push(ink(v.state === 'starting' ? `Starting ${where}` : `Working ${where}`, 'orange', colour, true));
      for (const step of (v.steps ?? []).slice(-4)) lines.push(ink(remote(step.text, Math.max(10, width - 2)), 'muted', colour));
    }
    if (v.plan && !(v.plan.state === 'rejected')) lines.push(taskCard(v.plan, { width, colour, approval: Boolean(v.approvals?.length) }));
    for (const item of v.approvals ?? []) lines.push([ink(`Waiting for your approval ${where}`, 'orange', colour, true), ink(`${!item.role || item.role === 'lead' ? 'The model' : item.role.replace(/^bot:/, '@')} wants to:`, 'text', colour), note(item.summary, 'text', width), ink('Esc, then y allow · n deny', 'muted', colour)].join('\n'));
    if (v.error) lines.push(note(v.error, 'orange', width));
    if (v.behind) lines.push(note(`Catching up with @${row.machine}…`, 'muted', width));
    lines.push(note(`Runs ${where}${v.project ? ` in ${remote(v.project, 40)}` : ''}. Type below to continue it there.`, 'muted', width));
    return lines.join('\n\n');
  }
  // The message box, while a session on another computer is under the cursor.
  const label = row => ` Message ${row.remote.title ? 'this session' : 'it'} on @${row.machine} `;
  async function start(machine, text, settings) {
    const result = await peerCommand({ type: 'remoteStart', to: machine.key, text, permissions: settings.permissions, place: settings.place, model: settings.model ?? null, bots: settings.bots ?? [] });
    // The list reads its rows again at once, so the new one is there for the cursor.
    read.at = 0;
    return { id: result.id, key: `remote:${machine.key}\0remote\0${result.id}`, line: `Started on @${machine.name}${result.project ? ` in ${remote(result.project, 40)}` : ''}. It shows here as it works.` };
  }
  async function send(row, text) {
    await peerCommand({ type: 'remoteSend', id: row.id, text });
    return `Sent to the session on @${row.machine}.`;
  }
  // y, n, s and c on a session on another computer. Whoever answers first, here or there, wins.
  async function action(row, action) {
    if (row.approval && ['accept', 'decline'].includes(action)) {
      const { answered } = await peerCommand({ type: 'remoteAnswer', id: row.id, approval: row.approval.id, decision: action === 'accept' ? 'allow' : 'deny' });
      return answered ? action === 'accept' ? 'Allowed.' : 'Denied.' : 'That approval was already answered.';
    }
    if (row.label === 'TASK' && ['accept', 'decline'].includes(action)) {
      const { answered } = await peerCommand({ type: 'remoteTask', id: row.id, decision: action === 'accept' ? 'approve' : 'reject' });
      return answered ? action === 'accept' ? `Task approved. It starts on @${row.machine}.` : 'Task rejected. Nothing was changed.' : 'That Task was already answered.';
    }
    if (action === 'stop') { await peerCommand({ type: 'remoteStop', id: row.id }); return `Stopping it on @${row.machine}. Changes and chat history are kept there.`; }
    if (action === 'close') { await peerCommand({ type: 'remoteForget', id: row.id }); read.at = 0; return `Removed from this list. It stays on @${row.machine}.`; }
    return null;
  }
  // /mine: which of your teammates' machines are yours. Both machines mark each other.
  async function mine(args) {
    const all = machines(), marked = marks();
    if (!args.length) {
      const rows = [...marked.values()].filter(row => row.mine || row.theirs);
      if (!rows.length) return `No other computer is yours yet. Run /mine @name here and on that computer, or /invite and choose Another computer of mine.`;
      return rows.map(row => { const name = `@${all.get(row.key)?.name ?? row.key.slice(0, 8)}`; return row.mine && row.theirs ? `${name} is yours` : row.mine ? `${name}: waiting for it to mark this machine too` : `${name} marks this machine as its own; /mine ${name} agrees`; }).join(' · ');
    }
    const remove = args[0] === 'remove', word = remove ? args[1] : args[0];
    if (args.length !== (remove ? 2 : 1) || !word?.startsWith('@')) throw new Error(`Use ${MINE_USAGE}.`);
    const machine = find(word);
    if (!machine) throw new Error(`No teammate's computer is called ${word}.`);
    if (remove) { await peerCommand({ type: 'unmine', key: machine.key }); return `@${machine.name} is no longer yours. Neither computer can start sessions on the other now.`; }
    const { both, older } = await peerCommand({ type: 'mine', key: machine.key });
    return both ? `@${machine.name} is yours. Type @${machine.name} first in the new session box to start a session there.` : older ? `@${machine.name} needs to update ELU Code to run sessions from here.` : `Waiting for @${machine.name} to mark this machine too.`;
  }
  // The answer to "Is <name>'s computer yours too?" after joining with a code made for that: yes marks it here.
  async function agree(key, owner) {
    const { both } = await peerCommand({ type: 'mine', key }), who = machines().get(key)?.name || plainName(owner) || key.slice(0, 8);
    return both ? `@${who} is yours. Type @${who} first in the new session box to start a session there.` : `Marked as yours. Once @${who} hears it, type @${who} first in the new session box to start a session there.`;
  }
  return { rows, named, view, label, start, send, action, mine, agree };
}
