import { remoteRow } from './board.mjs';
import { sessionChanges } from './diff.mjs';
import { taskCard, taskPlace } from './terminal-plan.mjs';
import { waitText } from './waiting.mjs';
import { remote, silentLine, stepLines, stepsLine, tagged, wrapText } from './terminal-visuals.mjs';
import { inTimeOrder, runsOfEntries, runSeconds } from './run-activity.mjs';
import { columns } from './width.mjs';
import { fileCount } from './peer/files.mjs';
import { EDIT_UPDATE } from './peer/reach-text.mjs';
// An entry from an older ELU there has no model or effort, and its header reads as before.
import { entryTag as tagOf } from './models.mjs';
import { AUTO_LINE, HELPER_AUTO_MAX, sentEntries } from './remote-helper.mjs';
import { yourComputer } from './terminal-commands.mjs';
import { runsCommand, sentWords, shortTag, waitingWords } from './message-aside.mjs';

// The app's side of sessions on your other computers (lib/peer/remote.mjs): the rows they
// add to Sessions, what shows beside the list when one is under the cursor, the keys that
// act on one, and /mine. Everything it reads comes from the peer facade's files; everything
// it does goes to the daemon as a command. deps are the app's own helpers, passed in so this
// file draws as the rest of the app does.
export const MINE_USAGE = '/mine [@name | remove @name | auto on | auto off]';
// Over a session on another computer of mine, a message goes to that session. This name
// first, and only it, writes to my agent here for it instead (lib/remote-helper.mjs).
export const HERE = '@here';
// The key bar while the box is over a session there. to: where route() sends what is typed.
// It names where Enter sends and, for a session of mine, the one name that asks my agent here.
// page: the keys that page its chat, when there is more of it than the pane shows.
export const boxKeys = (row, to, page = []) => [['enter', to === 'there' ? `send to @${row.machine}` : 'send to your agent here'], ...(to === 'there' && row.by !== 'teammate' ? [[HERE, 'asks your agent here']] : []), ...page, ['esc', 'sessions']];
// Typing @ over a session of mine there offers that one name: every other word goes to the session.
export function hereMention(row, text) {
  const match = /^@([^\s@]*)$/.exec(text);
  return !match || row.by === 'teammate' || !HERE.slice(1).startsWith(match[1].toLowerCase()) ? [] : [{ word: HERE, description: `your agent on this computer · it helps the session on @${row.machine}`, more: true, value: HERE }];
}
const plainName = value => remote(value, 40).replace(/[\s@]+/g, '');
const WEEK = 7 * 86400000;
// Who started a session on my other computer, as its pane says it: a teammate, a schedule or a bot.
const startedBy = row => row.by === 'teammate' && row.who ? ` Started by @${row.who}.` : row.by === 'schedule' ? ' Started by a schedule.' : row.by === 'bot' && row.who ? ` @${row.who}'s chat.` : '';
// restMs: how long the cursor rests on a session not followed here yet before it is watched there.
// stepsShown(key): whether the steps of the turn with that key are open, as the app keeps it
// for its own chat (Ctrl-O, a click on the turn's line).
export function remoteSessions({ facade, peerRead, peerCommand, chatMessage, ink, colour, toneOfBot = () => 'violet', restMs = 300, stepsShown = () => false }) {
  const list = (name, ...args) => { try { const value = facade?.[name]?.(...args); return Array.isArray(value) ? value : []; } catch { return []; } };
  // Every teammate's machine, with the name it goes by here: its box name, else its owner's name.
  const machines = () => {
    const status = peerRead('peerStatus'), seen = new Map();
    for (const member of (status?.teams ?? []).flatMap(team => team?.members ?? [])) if (member?.key && member.key !== status.key && !seen.has(member.key)) seen.set(member.key, { key: member.key, name: plainName(member.box) || plainName(member.name) || member.key.slice(0, 8), owner: plainName(member.name), box: plainName(member.box), online: Boolean(member.online) });
    return seen;
  };
  const marks = () => new Map(list('mineRows').map(row => [row.key, row]));
  // What this machine goes by on the others, so /mine there can find it: its box name, else its owner's name.
  const self = () => { const status = peerRead('peerStatus'); return plainName(status?.box) || plainName(status?.name) || 'NAME'; };
  // Teammates' machines that are not both mine yet: the ones /invite offers to make mine without a code.
  const unmarked = () => { const marked = marks(); return [...machines().values()].filter(row => !(marked.get(row.key)?.mine && marked.get(row.key)?.theirs)); };
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
  // The computers this machine marked as its own, by key: each reads as your computer wherever
  // its @name shows, never as a teammate, and under one name, the one Sessions and /mine call
  // it. waiting: it has not marked this machine back yet, so it is not mine yet
  // (lib/peer/mine.mjs), and every place that calls it your computer says so. Read from the
  // daemon's files at most every 250 ms: a draw names many peers.
  let marked = { at: 0, rows: new Map() };
  const yours = (now = Date.now()) => {
    if (now - marked.at > 250 || now < marked.at) {
      // With none marked, the teams are not read: on no team nothing asks the daemon's status.
      const rows = [...marks().values()].filter(row => row.mine), all = rows.length ? machines() : null;
      marked = { at: now, rows: new Map(rows.map(row => [row.key, { key: row.key, name: all.get(row.key)?.name ?? row.key.slice(0, 8), waiting: !row.theirs }])) };
    }
    return marked.rows;
  };
  const own = key => yours().has(key);
  // What says a peer is another computer of mine, or '' for a teammate.
  const words = (key, between) => { const row = yours().get(key); return yourComputer(row?.waiting ? { ...row, online: machines().get(key)?.online } : row, between); };
  // Read from their files at most every 500 ms: the list is drawn far more often. views: the
  // sessions this machine follows (started from here, or opened here); lists: every session
  // on each computer of mine, as it last listed them.
  let read = { at: 0, views: [], lists: new Map() };
  const fresh = now => { if (now - read.at > 500 || now < read.at) read = { at: now, views: list('remoteSessions'), lists: new Map(list('remoteMachines').map(row => [row.key, row])) }; return read; };
  // Computers both machines marked as mine, with the name they go by here and whether they are online.
  const ours = () => { const marked = marks(); if (![...marked.values()].some(row => row.mine && row.theirs)) return []; const all = machines(); return [...marked.values()].filter(row => row.mine && row.theirs).map(row => all.get(row.key) ?? { key: row.key, name: row.key.slice(0, 8), online: false }); };
  // The repository of a project here, read again every minute: Sessions shows the sessions of my
  // computers' projects of the same repository.
  const repos = new Map();
  const repoOf = (root, now = Date.now()) => {
    if (!root) return null;
    const known = repos.get(root); if (known && now - known.at < 60000) return known.id;
    let id = null; try { id = facade?.projectRepoId?.(root) ?? null; } catch { id = null; }
    repos.set(root, { id, at: now }); return id;
  };
  // Every repository the open project holds, read again every minute: its own, and those its
  // Kanban has boards for, as the daemon last found them (the clones its folder holds and the
  // ones its recent sessions work in); the app asks git nothing for it. A session of my other
  // computer working in one of them shows under that computer's heading.
  const held = new Map();
  const holds = (root, now = Date.now()) => {
    if (!root) return new Set();
    const known = held.get(root); if (known && now - known.at < 60000 && now >= known.at) return known.ids;
    const ids = new Set([repoOf(root, now), ...list('projectRepoIds', root)].filter(id => typeof id === 'string' && id));
    if (held.size > 50) held.clear();
    held.set(root, { at: now, ids }); return ids;
  };
  // Whether Sessions shows a listed session under its computer's heading, with the open project's
  // repository (repo) and every one it holds (here): by the repository the session works in,
  // else, from a build that names none, by its project's.
  const shows = (item, project, repo, here) => item.repoId ? here.has(item.repoId) : Boolean(repo) && project?.repoId === repo;
  // A project of another computer opened from Projects: its sessions show under their own heading.
  let opened = null;
  // The sessions there the owner wrote to from this window: each stays listed under its
  // computer, whatever project it is in there, so what it answers shows where he wrote.
  const written = new Set();
  const mineHere = (view, item) => Boolean(view && !view.ref) || written.has(item.id) || Boolean(view && written.has(view.id));
  // Sessions under the cursor that were asked to be watched: when, and why one could not be.
  // One that failed is asked again after a while, never on every draw; one that was busy, sooner.
  const asked = new Map(), RETRY_MS = 30000, BUSY_MS = 5000;
  let resting = { id: null, at: 0 };
  // Asks a session's computer to send it here, unless it was asked a moment ago or is offline.
  function follow(row) {
    const tried = asked.get(row.id);
    if (!row.online || tried && (tried.pending || Date.now() - tried.at < (tried.busy ? BUSY_MS : RETRY_MS))) return;
    asked.set(row.id, { pending: true, at: Date.now() });
    peerCommand({ type: 'remoteWatch', to: row.remote.machine, ref: row.ref, cursor: true }).then(() => { asked.delete(row.id); read.at = 0; },
      error => asked.set(row.id, { error: error.message, busy: /is busy|Too many requests/.test(error.message), at: Date.now() }));
  }
  // The changes of a session there, for its Changes tab: what its computer sent, read once
  // for each text it sends and whole, however long. Until they are here, note says why in a
  // line. fetch: the tab opened, so a session not followed here yet is asked for at once.
  const diffs = new Map();
  function changes(row, { fetch = false } = {}) {
    const v = row.remote, patch = typeof v.diff?.patch === 'string' ? v.diff.patch : '', waits = row.listed && !row.watched && Boolean(row.ref);
    if (fetch && waits) follow(row);
    if (patch) {
      let kept = diffs.get(row.id);
      if (kept?.patch !== patch) { kept = { patch, changes: sessionChanges(patch) }; diffs.delete(row.id); diffs.set(row.id, kept); if (diffs.size > 24) diffs.delete(diffs.keys().next().value); }
      // With no file to list, the one line it sent about its changes is still said.
      if (kept.changes.files.length || kept.changes.note) return { changes: kept.changes, note: null };
    }
    const failed = waits ? asked.get(row.id) : null;
    if (waits) return { changes: null, tone: failed?.error && !failed.busy && row.online ? 'orange' : 'muted', note: !row.online ? `@${row.machine} is offline. Its changes show here once it is back.` : failed?.error && !failed.busy ? failed.error : `@${row.machine} has not sent its changes yet. Asking for them…` };
    return { changes: null, tone: 'muted', note: v.partialDiff ? `Its changes are arriving from @${row.machine}…` : v.behind ? `Catching up with @${row.machine}…` : 'No changes yet.' };
  }
  // One session of a computer of mine as a row. view: what this machine follows of it, live;
  // item: how that computer last listed it. The row's key is the session's id either way. Its
  // time and place in the list are the listing's: a watch stamps its first events with the
  // moment it was made, which is not when the session last did anything.
  // A run there that waits to start with no session yet (queued) comes with its message and
  // what it waits for; once its computer lists the session it started, it is that session.
  // archived: its computer archived it (its listing says so); named: someone chose its name there.
  function sessionRow(machine, item, view, project, now) {
    const told = view ? item?.at ? { ...view, lastAt: item.at, ...(item.since ? { since: item.since } : {}) } : view : { id: item.id, machine: machine.key, createdAt: item.createdAt, lastAt: item.at, state: item.state, finished: item.finished, title: item.title, question: item.question, error: item.error, plan: item.plan, approvals: item.approvals, steps: [], entries: [], ...(item.since ? { since: item.since } : {}), ...(item.queued ? { queued: true, text: item.text ?? '', ...(item.waits ? { waits: item.waits } : {}) } : {}) };
    const v = item?.archived === true ? { ...told, archived: true } : told;
    const row = remoteRow(v, machine.name, now);
    return { ...row, project: project?.name ?? v.project ?? '-', listed: Boolean(item), ref: item?.ref ?? view?.ref ?? null, watched: Boolean(view), online: machine.online === true, by: item?.by ?? (view && !view.ref ? 'here' : null), who: item?.who ?? null, grouped: true, last: Date.parse(v.lastAt ?? v.createdAt ?? 0) || 0, ...((item ? item.queued : v.queued) ? { queued: true } : {}), ...(item?.named === true ? { named: true } : {}) };
  }
  // Each session of a computer of mine, once: as it listed it, with what this machine follows
  // of it (the same session by its id from here, by the id both machines give it, or by its
  // place there). A view that lost its place there, such as a watch its events made again
  // here, takes the listed place, so it is the same session everywhere. Then the ones started
  // from here that it has not listed (yet, or on a build that cannot list), and, for a computer
  // with no list, the ones watched here.
  function each(machine, kept, views) {
    const own = views.filter(view => view.machine === machine.key), byId = new Map(own.map(view => [view.id, view])), byRef = new Map(own.filter(view => view.ref).map(view => [view.ref, view]));
    const out = [], used = new Set();
    for (const item of kept?.sessions ?? []) {
      const found = (item.remoteId && byId.get(item.remoteId)) || byId.get(item.id) || byRef.get(item.ref) || null;
      const view = found && !found.ref && (found.id === item.id || found.handoff && found.id === item.remoteId) ? { ...found, ref: item.ref } : found;
      if (view) used.add(view.id);
      out.push({ item, view });
    }
    for (const view of own) if (!used.has(view.id) && (!view.ref || !kept?.listedAt)) out.push({ item: null, view });
    return out;
  }
  // The sessions of each computer of mine, as Sessions shows them: those working in a repository
  // the open project (root) holds, those started from here, and those of a project opened from
  // Projects. A session its computer names no repository for (an older build, or one in no
  // repository) goes by its project's: the same as the open project's. Finished ones stay a week, as here.
  // Those it archived are kept apart (stored), for /archived: they show last, under their own heading.
  function groups(now = Date.now(), root = null) {
    const { views, lists } = fresh(now), mine = ours(), out = [];
    if (!mine.length) return out;
    const repo = repoOf(root, now), here = holds(root, now);
    for (const machine of mine) {
      const kept = lists.get(machine.key), projects = new Map((kept?.projects ?? []).map(row => [row.id, row]));
      const main = [], other = [], stored = [];
      let away = 0;
      for (const { item, view } of each(machine, kept, views)) {
        if (!item) { if (!view.ref) main.push(sessionRow(machine, null, view, null, now)); continue; }
        const project = projects.get(item.project), same = shows(item, project, repo, here), open = opened?.key === machine.key && opened.project === item.project;
        if (item.archived === true) { if (same || open || mineHere(view, item)) stored.push(sessionRow(machine, item, view, project, now)); continue; }
        if (!same && !mineHere(view, item)) away++;
        if (!same && !open && !mineHere(view, item)) continue;
        (same || mineHere(view, item) ? main : other).push(sessionRow(machine, item, view, project, now));
      }
      const recent = row => row.group !== 3 || now - row.last < WEEK, newest = (a, b) => b.last - a.last;
      out.push({ machine, older: kept?.older === true, listed: Boolean(kept?.listedAt), away, rows: main.filter(recent).sort(newest), opened: open(machine, projects), other: other.filter(recent).sort(newest), stored: stored.sort(newest) });
    }
    return out;
  }
  const open = (machine, projects) => opened?.key === machine.key ? projects.get(opened.project) ?? null : null;
  const keyed = row => ({ ...row, key: `remote:${row.remote.machine}\0remote\0${row.id}` });
  // Board lines after this machine's own: a heading per computer of mine, online or offline,
  // its sessions newest first, then those of the project opened from Projects, then, with
  // /archived (archived), the ones it archived.
  function sections(now = Date.now(), root = null, { archived = false } = {}) {
    const lines = [];
    for (const group of groups(now, root)) {
      const { machine } = group;
      if (!group.rows.length && !group.older && !group.listed && !group.opened && !(archived && group.stored.length)) continue;
      lines.push({ spacer: true }, { header: `On ${machine.name} · ${machine.online ? 'online' : 'offline'}`, tone: machine.online ? 'violet' : 'muted', count: group.rows.length });
      if (group.older) lines.push({ note: `Update ELU on ${machine.name} to see its sessions here.` });
      else if (!group.rows.length) lines.push({ note: group.away ? `No sessions of this project. Projects lists its others.` : 'No sessions yet.' });
      for (const row of group.rows) lines.push({ row: keyed(row) });
      if (group.opened) {
        lines.push({ spacer: true }, { header: `${group.opened.name} on ${machine.name}`, tone: 'violet', count: group.other.length });
        if (!group.other.length) lines.push({ note: 'No sessions yet.' });
        for (const row of group.other) lines.push({ row: keyed(row) });
      }
      if (archived && group.stored.length) {
        lines.push({ spacer: true }, { header: `Archived on ${machine.name}`, tone: 'muted', count: group.stored.length });
        for (const row of group.stored) lines.push({ row: keyed(row) });
      }
    }
    return lines;
  }
  // How many sessions my computers archived that /archived would list here.
  const archivedCount = (now = Date.now(), root = null) => groups(now, root).reduce((count, group) => count + group.stored.length, 0);
  // What waits for me on a computer of mine, in any of its projects (its home folder too): an
  // allow or deny, a Task to approve, a question. Each is a row of its own under Needs you
  // here, marked with the computer, beside the session's row under its computer when
  // Sessions lists it there.
  function rows(now = Date.now()) {
    const { views, lists } = fresh(now), out = [];
    for (const machine of ours()) {
      const kept = lists.get(machine.key), projects = new Map((kept?.projects ?? []).map(row => [row.id, row]));
      for (const { item, view } of each(machine, kept, views)) {
        const row = sessionRow(machine, item, view, item ? projects.get(item.project) : null, now);
        if (row.group === 0) out.push({ ...row, grouped: false, keyId: `${row.id}/wants` });
      }
    }
    return out;
  }
  // The projects of my computers with sessions Sessions does not show here: "<project> on <name>"
  // in Projects, with how many (sessions). A session of my other computer that works in a
  // repository this project holds is part of this project, whatever folder its project is
  // there (a folder of clones, the home folder): it shows under that computer's heading, as one
  // started from here does, so a project there whose sessions all show here is not listed again.
  // Nor is one with no sessions yet: opened, it would show nothing, and new sessions there start
  // from here with @name. One working in no repository, or one this project does not hold, is
  // reached from here.
  function projects(now = Date.now(), root = null) {
    const { views, lists } = fresh(now), mine = ours(), out = [];
    if (!mine.length) return out;
    const repo = repoOf(root, now), here = holds(root, now);
    for (const machine of mine) {
      const kept = lists.get(machine.key); if (!kept || kept.older) continue;
      const listed = each(machine, kept, views).filter(pair => pair.item);
      for (const project of kept.projects ?? []) {
        const away = listed.filter(({ item, view }) => item.project === project.id && item.archived !== true && !shows(item, project, repo, here) && !mineHere(view, item)).map(pair => pair.item);
        if (!away.length) continue;
        out.push({ remote: true, key: machine.key, id: project.id, root: `remote:${machine.key}:${project.id}`, name: `${project.name} on ${machine.name}`, project: project.name, repoId: project.repoId ?? null, machine: machine.name, online: machine.online, sessions: away.length, last: away[0]?.at ?? null });
      }
    }
    return out;
  }
  // The key of one session of a computer of mine (key) as Sessions lists it with the open
  // project (root), or null when it is not there: by its id when it was started from here
  // (remote), else by its place on that computer (ref).
  function sessionKey(key, { remote = null, ref = null } = {}, root = null) {
    for (const group of groups(Date.now(), root)) if (group.machine.key === key) for (const row of [...group.rows, ...(group.opened ? group.other : [])]) if ((remote && row.id === remote) || (ref && row.ref === ref)) return keyed(row).key;
    return null;
  }
  // Opens a project of a computer of mine in Sessions; the key of its newest session, if any.
  function openProject(key, project) {
    opened = { key, project };
    const group = groups(Date.now()).find(row => row.machine.key === key);
    const first = group?.other[0] ?? group?.rows.find(row => row.listed && (fresh(Date.now()).lists.get(key)?.sessions ?? []).some(item => item.ref === row.ref && item.project === project));
    return first ? keyed(first).key : null;
  }
  // Wrapped one column short of the pane, as a note in a local chat is (lib/terminal.mjs): blessed
  // wraps a coloured row that fills the pane again, at its last space, which left "the" of
  // "write to the session there." on a row of its own.
  const note = (text, tone, width) => wrapText(text, width - 1).map(row => ink(row, tone, colour)).join('\n');
  // A session on another computer arrives with its newest entries. The ones before them are
  // asked for when the owner pages up to the oldest one held here (older, called by the pane
  // while its first line is in view), a page at a time, until the first entry is here.
  const olderAsked = new Map();
  // How many entries come before the oldest one held: each says its place in the chat (n).
  const earlier = v => { const first = (v?.entries ?? []).reduce((least, entry) => Number.isSafeInteger(entry.n) && entry.n < least ? entry.n : least, Infinity); return Number.isFinite(first) ? first - 1 : 0; };
  // A session followed since before entries said their place holds a first look of them with
  // none: its computer is asked for the places (an ELU that knows none there is asked once).
  const unplaced = v => (v?.entries?.length ?? 0) >= 80 && !v.entries.some(entry => Number.isSafeInteger(entry.n));
  const loading = row => { const tried = olderAsked.get(row.id); return Boolean(tried && !tried.error && (tried.pending || tried.left === earlier(row.remote) && Date.now() - tried.at < RETRY_MS)); };
  function older(row) {
    const places = unplaced(row.remote), left = places ? -1 : earlier(row.remote), tried = olderAsked.get(row.id), now = Date.now();
    if (!left || !row.online || row.listed && !row.watched) return;
    if (tried && (tried.pending || tried.left === left && (places && !tried.busy || now - tried.at < (tried.busy ? BUSY_MS : RETRY_MS)))) return;
    olderAsked.set(row.id, { pending: true, at: now, left });
    peerCommand({ type: 'remoteOlder', id: row.id }).then(() => { olderAsked.set(row.id, { at: Date.now(), left }); read.at = 0; },
      error => olderAsked.set(row.id, { error: error.message, busy: /is busy|Too many requests/.test(error.message), at: Date.now(), left }));
  }
  // What shows beside the list for a session on another computer: its chat as a local
  // session shows it, in time order. Its Task sits after the reply that proposed it; then
  // come what it asks, why it stopped, the steps it is taking while it works, and last, right
  // above the message box, what the owner sent that it has not read yet. What is about the
  // session and not about a moment of it (where it runs, that this computer is catching up)
  // sits above its first message. Its changes are in its Changes tab, whose name counts
  // them, as for a session here. Drawn as parts, a blank line between two, each with a key
  // that names what it shows, so the pane can keep the owner on the part he reads while
  // others come and go.
  // helper: your agent here for it, once asked for with @here (lib/remote-helper.mjs), whose
  // chat shows in the same pane, in time order: { model, entries, working, stopped, sends }.
  function parts(row, width, helper = null) {
    // BESIDE: how the answer to a message beside a turn is titled (lib/message-aside.mjs asideRows): "Codex on @devbox · beside the turn" here.
    const v = row.remote, where = `on @${row.machine}`, BESIDE = ' · beside the turn', lines = [], seen = new Map();
    const add = (key, text, into = lines) => { const n = seen.get(key) ?? 0; seen.set(key, n + 1); into.push({ key: `${key}\0${n}`, text }); };
    const hereKey = entry => `here\0${entry.at ?? ''}\0${entry.role ?? ''}\0${entry.text ?? ''}`;
    // A run there that waits to start with no session yet (a schedule's run that waits for a
    // free slot, say) shows its message under who wrote it and what it waits for, in the
    // sentence that computer's own chat says it. What the owner types goes with its message
    // and starts it there now, as typing into it there does; /stop cancels it. It is watched
    // there once the cursor rests on it, so the session it starts shows here in its place.
    if (row.queued && v.state === 'starting') {
      const now = Date.now();
      if (row.listed && !row.watched && row.ref) { if (resting.id !== row.id) resting = { id: row.id, at: now }; if (now - resting.at >= restMs) follow(row); }
      const sender = row.by === 'schedule' ? 'Schedule' : byTeammate(row) && row.who ? `@${row.who}` : row.by === 'bot' && row.who ? `You → @${row.who}` : 'You';
      add('runs', note(`Waits to start on @${row.machine}${row.project && row.project !== '-' ? ` in ${remote(row.project, 40)}` : ''}. ${byTeammate(row) ? "It is a teammate's message: it starts there by itself." : 'What you type goes with it and starts it now. /stop cancels it.'}`, 'muted', width));
      add('queued', chatMessage({ title: `${sender} (queued)`, at: v.createdAt, text: v.text || v.title || '', tone: 'blue', shaded: true }, width, colour));
      add('waits', note(waitText(v.waits, now, { there: `@${row.machine}` }) ?? `Starting on @${row.machine}.`, 'muted', width - 1));
      return lines;
    }
    // One started here while its computer was offline is kept here until it connects
    // (unsent, lib/peer/remote.mjs), and says so under the message. What the owner types goes
    // with it; /stop cancels it, and nothing is sent.
    if (v.unsent && v.state === 'starting') {
      add('unsent', chatMessage({ title: `You → @${row.machine} (not sent yet)`, narrow: 'You (not sent yet)', at: v.createdAt, text: v.text || v.title || '', tone: 'blue', shaded: true }, width, colour));
      add('offline', note(row.online ? `Sending it to @${row.machine}…` : `@${row.machine} is offline. Your message goes as soon as it connects. /stop cancels it.`, 'muted', width - 1));
      return lines;
    }
    // A session not followed here yet is watched there once the cursor rests on it; until its
    // events arrive, what its computer listed shows. An offline computer is not asked.
    if (row.listed && !row.watched && row.ref) {
      const now = Date.now();
      if (resting.id !== row.id) resting = { id: row.id, at: now };
      if (now - resting.at >= restMs) follow(row);
      // Who started it shows from this first frame on, as it does once its events are here.
      const failed = asked.get(row.id), said = !row.online ? `@${row.machine} is offline. What it listed last is shown.` : failed?.error && !failed.busy ? failed.error : `Opening it on @${row.machine}…${startedBy(row)}`;
      add('listed', chatMessage({ title: v.title || 'Session', text: [v.question, v.error].filter(Boolean).join('\n\n') || `${row.label}`, tone: 'blue', shaded: true }, width, colour));
      add('opening', note(said, failed?.error && !failed.busy && row.online ? 'orange' : 'muted', width));
      for (const entry of [...helper?.entries ?? []].sort((a, b) => Boolean(a.waiting) - Boolean(b.waiting) || Date.parse(a.at ?? 0) - Date.parse(b.at ?? 0))) add(hereKey(entry), hereMessage(entry, helper, width));
      return lines;
    }
    const entries = v.entries?.length ? v.entries : v.text ? [{ role: 'You', at: v.createdAt, text: v.text }] : [];
    // What is about the session and not about a moment of it sits above its first message,
    // so nothing but what the owner sent last ends the pane: where it runs and how to write
    // to it, and that this computer is catching up with it.
    add('runs', note(`Runs ${where}${v.project ? ` in ${remote(v.project, 40)}` : ''}.${startedBy(row)} ${byTeammate(row) ? 'Type below to continue it there.' : `Type below to write to it there. Start with ${HERE} to ask your agent here.`}`, 'muted', width));
    if (v.behind) add('behind', note(`Catching up with @${row.machine}…`, 'muted', width));
    if (earlier(v)) {
      const count = earlier(v), failed = olderAsked.get(row.id)?.error, these = `${count} earlier message${count === 1 ? ' is' : 's are'} on @${row.machine}.`;
      add('earlier', note(loading(row) ? `Loading earlier messages from @${row.machine}… ${count} more ${count === 1 ? 'is' : 'are'} there.` : !row.online ? `${these} It is offline: they load once it is on.` : failed ? `${these} ${failed}` : `${these} Page up to load them.`, failed && row.online && !loading(row) ? 'orange' : 'muted', width));
    }
    // What each turn there did (lib/run-activity.mjs), folded into one line above its reply,
    // as a session here shows it. A run still going has no end yet.
    const runs = (Array.isArray(v.runs) ? v.runs : []).filter(run => run?.steps?.length).map(run => ({ ...run, key: `${v.id}\0${run.run}` }));
    // A message answered beside the turn that still works there (lib/message-aside.mjs) shows
    // with what the owner sent that has not been read yet, under the working line and its steps;
    // once that turn is over it is in its place. That computer says how many of the newest rows
    // marked beside belong to its running turn (v.beside).
    const working = ['starting', 'preparing', 'running'].includes(v.state), besideTurn = working && v.beside > 0 ? inTimeOrder(entries).filter(entry => entry.beside).slice(-v.beside) : [];
    // One that says no time (an older ELU there sends a bot's review with none) stays after the one before it.
    const sorted = inTimeOrder(entries.filter(entry => !besideTurn.includes(entry))), { owned, before, after } = runsOfEntries(sorted, runs.filter(run => run.at));
    const folded = list => { const count = list.reduce((sum, run) => sum + run.steps.length, 0), open = stepsShown(list[0].key); return [stepsLine(count, runSeconds(list), open, colour, { stopped: list.some(run => run.stopped) }), ...(open ? [stepLines(list.flatMap(run => run.steps), { width: width - 1, colour })] : [])].join('\n'); };
    // The model, the bots and the shell of this chat are those of the other computer, and
    // their titles say so (Opus 5.5 on @devbox), so they are never taken for this computer's.
    // What was sent there from here reads You → @devbox, or the agent here's when it sent it.
    const fromHelper = sentEntries(v, helper?.sends ?? []);
    // A message answered beside a turn there (lib/message-aside.mjs): the answer under the name
    // of what wrote it, and the line that says where it came from.
    const answered = entry => entry.line ? note(entry.text, 'muted', width) : entry.update ? chatMessage({ title: entry.role.endsWith(BESIDE) ? `${entry.role.slice(0, -BESIDE.length)} ${where}${BESIDE}` : `${entry.role} ${where}`, narrow: entry.role, at: entry.at, text: entry.text, tone: entry.failed ? 'red' : 'orange' }, width, colour)
      : chatMessage({ title: `You → @${row.machine}`, at: entry.at, text: entry.text, tone: 'blue', shaded: true }, width, colour);
    // Its Task sits where it happened: after the reply that proposed it and before anything
    // that came later (taskPlace). One that waits with nothing after it is last by that rule.
    let place = v.plan && !(v.plan.state === 'rejected') ? taskPlace(sorted, v.plan) : -1;
    const card = () => add('task', taskCard(v.plan, { width, colour, approval: Boolean(v.approvals?.length) }));
    if (place === 0) card();
    // A message to the agent here that it has not read yet is drawn last, with those the session
    // has not read, and so is one answered beside the turn that still works there (besideTurn).
    for (const entry of inTimeOrder([...entries.filter(entry => !besideTurn.includes(entry)), ...(helper?.entries ?? []).filter(row => !row.waiting).map(row => ({ ...row, here: true }))])) {
      const key = entry.here ? hereKey(entry) : `entry\0${entry.at ?? ''}\0${entry.role ?? ''}\0${entry.text ?? ''}`;
      // A turn that ended with no reply (stopped there, or by a limit or a failure) stays where it happened.
      if (!entry.here) for (const turn of [before.get(entry), owned.get(entry)]) if (turn) add(`steps\0${turn[0].run}`, folded(turn));
      if (entry.here) add(key, hereMessage(entry, helper, width));
      else if (entry.role === 'You' && !entry.shell && !entry.bot) add(key, chatMessage({ title: `${fromHelper.has(entry) ? `${helper.model} here` : 'You'} → @${row.machine}`, at: entry.at, text: entry.text, tone: 'blue', shaded: true }, width, colour) + (entry.during ? '\n' + note(`Sent to the running turn on @${row.machine}.`, 'muted', width) : ''));
      // One answered beside a turn there that is over, in its place.
      else if (entry.line || entry.update) add(key, answered(entry));
      else if (entry.shell) add(key, chatMessage({ title: `${entry.role} ${where}`, at: entry.at, text: entry.text, tone: 'green', raw: true }, width, colour));
      else if (entry.bot) add(key, chatMessage({ ...tagged(entry.role, tagOf(entry), ` ${where}`), at: entry.at, text: entry.text, tone: entry.failed ? 'red' : entry.quiet ? 'muted' : toneOfBot(entry.bot) }, width, colour));
      else add(key, chatMessage({ ...tagged(entry.role, tagOf(entry), entry.lead ? ` ${where}` : ''), at: entry.at, text: entry.text, tone: entry.lead ? 'orange' : 'blue', shaded: !entry.lead }, width, colour));
      if (!entry.here && --place === 0) card();
    }
    if (after.length) add(`steps\0${after[0].run}`, folded(after));
    if (v.state === 'needs_input' && v.question) add('question', chatMessage({ title: 'Waiting for you', text: [v.question, (v.choices ?? []).map((choice, index) => `${index + 1}. ${choice}`).join('\n')].filter(Boolean).join('\n\n'), tone: 'orange' }, width, colour) + (byTeammate(row) ? '' : '\n' + note(v.choices?.length ? 'Type its number or your answer below.' : 'Type your answer below.', 'muted', width)));
    // Why it stopped, wrapped one column short of the pane as a local session's stop line is:
    // blessed wraps a coloured row that fills the pane again, at its last space.
    if (v.error) add('error', note(v.error, 'orange', width - 1));
    for (const item of v.approvals ?? []) add(`approval\0${item.id}`, [ink(`Waiting for your approval ${where}`, 'orange', colour, true), ink(`${!item.role || item.role === 'lead' ? 'The model' : item.role.replace(/^bot:/, '@')} wants to:`, 'text', colour), note(item.summary, 'text', width), ink(`y allow · n deny${item.always ? ' · a always' : ''}, then Enter`, 'muted', colour)].join('\n'));
    // Its agent here waits for the owner's approval, which is answered on its own row.
    for (const item of helper?.approvals ?? []) add(`here-approval\0${item.id ?? item.summary ?? ''}`, [ink('Waiting for your approval here', 'orange', colour, true), ink(`${helper.model} here wants to:`, 'text', colour), note(item.summary, 'text', width), note(`Answer it on the row of "${helper.title}" in Sessions, under Needs you.`, 'muted', width)].join('\n'));
    if (helper?.working && !helper.approvals?.length) add('here-working', ink(`${helper.model} is working here`, 'orange', colour, true));
    if (helper?.stopped && !helper.working) add('here-stopped', note(`The two agents stopped after ${HELPER_AUTO_MAX} turns by themselves. Write ${HERE} and your message to go on.`, 'muted', width));
    // The turn at work there, directly above what waits for it.
    const forTurn = (v.waiting ?? []).findLast(item => item.state === 'turn') ?? null;
    if (working && !v.approvals?.length) {
      add('working', ink(v.state === 'starting' ? `Starting ${where}` : `Working ${where}`, 'orange', colour, true));
      // Every step of the run in progress there, newest last. A computer whose ELU sends no
      // steps of its runs sends the newest lines of its activity instead.
      const newest = Array.isArray(v.runs) ? v.runs.at(-1) : null, live = newest && !newest.at && newest.steps?.length ? newest : null;
      if (live) add(`live\0${live.run}`, stepLines(live.steps, { width: width - 1, colour }));
      // A run there that prints only when it ends: how long it has worked, and why no step shows.
      else if (newest && !newest.at && newest.silent) add(`silent\0${newest.run}`, note(silentLine(newest.silent, Date.parse(newest.startedAt ?? '')), 'muted', width - 1));
      else for (const step of (v.steps ?? []).slice(-4)) add(`step\0${step.at ?? ''}\0${step.text ?? ''}`, ink(remote(step.text, Math.max(10, width - 2)), 'muted', colour));
      // What waits there for this turn to end, which its turn cannot take while it works: the
      // newest message below that waits for the turn names the key that sends it now (waits).
      // A computer that lists none says it here.
      if (Number.isInteger(v.held) && v.held > 0 && !byTeammate(row) && !forTurn) add('held', note(`${v.held > 1 ? `${v.held} of your messages wait` : 'Your message waits'} on @${row.machine} while this turn works. Enter in the empty message box sends ${v.held > 1 ? 'them' : 'it'} now.`, 'muted', width));
    }
    // One that has not started there says what it waits for, in the sentence that computer's
    // own chat shows (lib/waiting.mjs): a free slot there, a time, or teammates' slots, with
    // /slots named there, as /slots here changes this computer's. A view
    // that lists the waiting messages themselves (waiting) says it under each instead. It is
    // wrapped one column short of the pane: blessed wraps a row that fills the pane once more.
    const wait = v.waiting?.length ? null : waitText(v.waits, Date.now(), { there: `@${row.machine}` });
    if (wait && v.state === 'starting') add('waits', note(wait, 'muted', width - 1));
    // A message to a session at rest there that has not started says so.
    if (wait && v.state !== 'starting') add('waits', note(`A message to it waits on @${row.machine}. ${wait}`, 'muted', width - 1));
    // What the owner sent that has not been read yet ends the pane, right above the message
    // box, with nothing under it. While the turn there works, a message answered beside it
    // comes first, so a turn with many steps never pushes it out of sight; once that turn is
    // over it is in its place above. Then, in the order he sent them, a message to the session
    // that has not run there yet (heldMessages in lib/peer/remote.mjs), and one to his agent here.
    // Each says what happens to it there and when, never only that it waits (waits). The newest
    // one sent while the session works names the key that sends it now, where that computer
    // takes it. One typed while the session waits on an approval does not answer it, and says so.
    for (const entry of besideTurn) add(`beside\0${entry.at ?? ''}\0${entry.role ?? ''}\0${entry.text ?? ''}`, answered(entry));
    const unread = (v.waiting ?? []).map(item => {
      const words = waits(item, row, v), tone = item.state === 'blocked' || item.state === 'stuck' ? 'orange' : 'muted';
      const said = words.answer ? '\n' + chatMessage({ title: `${words.answer.who} ${where}${BESIDE}`, narrow: `${words.answer.who}${BESIDE}`, at: words.answer.at, text: words.answer.text, tone: 'orange' }, width, colour) + '\n' : '';
      const more = [...words.lines, ...(item === forTurn && words.keys ? [words.keys] : [])].map((text, index) => note(`${text}${index === 0 && item.state === 'turn' && v.approvals?.length ? ' The approval above still needs your answer.' : ''}`, tone, width));
      return { at: item.at, key: `waiting\0${item.at ?? ''}\0${item.text ?? ''}`, text: chatMessage({ title: `You → @${row.machine} (${words.tag})`, narrow: `You → @${row.machine} (${shortTag(words.tag)})`, at: item.at, text: item.text, tone: 'blue', shaded: true }, width, colour) + '\n' + said + more.join('\n') };
    });
    for (const entry of helper?.entries ?? []) if (entry.waiting) unread.push({ at: entry.at, key: hereKey(entry), text: hereMessage(entry, helper, width) });
    for (const item of unread.sort((a, b) => Date.parse(a.at ?? 0) - Date.parse(b.at ?? 0))) add(item.key, item.text);
    return lines;
  }
  const view = (row, width, helper = null) => parts(row, width, helper).map(part => part.text).join('\n\n');
  // What happens to a message to a session there that has not run yet, and when: { tag, lines,
  // keys, answer } (lib/message-aside.mjs waitingWords). One sent while the session works says
  // what its running turn does with it, as that computer tells it (takes). A computer on an
  // older ELU tells nothing: there the message starts when the turn ends and nothing answers
  // it before, which is said, with the key that sends it now where that computer takes it.
  function waits(item, row, v) {
    const name = row.machine, enter = Number.isInteger(v.held) && v.held > 0 && !byTeammate(row);
    if (item.state === 'blocked') return { tag: 'blocked', lines: [`${item.reason || `It did not start on @${name}.`} Send it again once that is fixed.`] };
    if (item.state === 'stuck') return { tag: 'not started yet', lines: [`ELU has not started this on @${name} yet and keeps trying. If it stays, open ELU there.`] };
    if (item.state === 'starting') return { tag: 'starting', lines: [`Starting on @${name}.`] };
    // Its /slots is that computer's, as the reason says it there.
    if (item.state !== 'turn') return { tag: 'starts next', lines: [item.reason ? item.reason.replace(/\/slots changes it\.$/, `/slots on @${name} changes it.`) : `Starts next on @${name}.`] };
    if (!item.takes) return { tag: 'starts when its turn ends', lines: [`@${name} runs an older ELU: this starts when its turn ends. Nothing reads or answers it before.`, `Updating ELU on @${name} answers a message at once.`],
      keys: enter ? `Enter in the empty box sends it now: that stops the turn on @${name} and the command that is running` : 'It cannot be sent now from here either.' };
    const taken = ['command', 'now', 'fixed'].includes(item.takes);
    return waitingWords({ state: 'queued', ...(taken ? { turn: {} } : {}), ...(item.takes === 'now' ? { now: true, ...(item.reason ? { reason: item.reason } : {}) } : {}), ...(item.takes === 'fixed' ? { fixed: true } : {}), ...(item.aside ? { aside: item.aside } : {}) },
      { working: true, goes: taken || item.takes === 'step', deaf: item.takes === 'beside', soon: item.takes === 'soon', stops: item.stops === true, command: commandThere(v) ?? true, readOnly: true, enter, there: `@${name}` });
  }
  // Whether the turn there runs a command now, from the steps of its run that computer sent;
  // null when it sent none (an older ELU, or a run that prints only when it ends).
  const commandThere = v => { const newest = Array.isArray(v?.runs) ? v.runs.at(-1) : null; return newest && !newest.at && newest.steps?.length ? runsCommand(newest.steps) : null; };
  // What the status line says once a message went to a session there that is in a turn: the same, in one line.
  const sentWhile = (row, result) => result?.working !== true ? '' : ['turn', 'beside', 'soon'].includes(result.takes) ? ` ${sentWords({ goes: result.takes === 'turn', deaf: result.takes === 'beside', soon: result.takes === 'soon', command: commandThere(row.remote) === true, there: `@${row.machine}` })}`
    : ` @${row.machine} runs an older ELU: this starts when its turn ends. Nothing reads or answers it before.`;
  // One entry of your agent here in that pane: its model's reply, your message to it, a turn
  // it took by itself after the session there answered, or your message still waiting.
  function hereMessage(entry, helper, width) {
    const auto = !entry.lead && !entry.bot && !entry.shell && AUTO_LINE.exec(entry.text ?? '');
    if (auto) return chatMessage({ title: `Automatic turn ${auto[1]} of ${auto[2]}`, at: entry.at, text: `@${String(entry.text).match(/^@(\S+) answered/)?.[1] ?? 'it'} answered. ${helper.model} here goes on by itself.`, tone: 'muted' }, width, colour);
    if (entry.lead) return chatMessage({ ...tagged(entry.role, tagOf(entry), ' here'), at: entry.at, text: entry.text, tone: 'orange' }, width, colour);
    if (entry.shell || entry.bot) return chatMessage({ ...tagged(entry.role, tagOf(entry), ' here'), at: entry.at, text: entry.text, tone: entry.shell ? 'green' : entry.failed ? 'red' : entry.quiet ? 'muted' : toneOfBot(entry.bot), ...(entry.shell ? { raw: true } : {}) }, width, colour);
    return chatMessage({ title: entry.waiting ? 'You (starts next)' : entry.role, at: entry.at, text: entry.text, tone: 'blue', shaded: true }, width, colour);
  }
  // The names a leading @word may call the computer of a session there: as its row shows it,
  // its box name, or its owner's name there when that is not this computer's own.
  function callsIt(row, word) {
    if (!/^@[^\s@]+$/.test(word ?? '')) return false;
    const wanted = word.slice(1).toLowerCase(), machine = machines().get(row.remote.machine), me = plainName(peerRead('peerStatus')?.name).toLowerCase();
    return [row.machine, machine?.name, machine?.box, machine?.owner && machine.owner.toLowerCase() !== me ? machine.owner : null].some(name => name && name.toLowerCase() === wanted);
  }
  // A teammate's session on that computer, such as a handoff accepted there: no agent here
  // helps it, since nothing is sent to it from here (lib/peer/session-tools.mjs), so every
  // message goes to it, as before. One a message from a computer of mine started there is
  // mine, not a teammate's (lib/peer/remote.mjs), and is helped as any of mine.
  const byTeammate = row => row.by === 'teammate';
  // Where a message over a session on another computer goes: to the session there, as if
  // typed on that computer (that computer's @name first, or @model, is taken off: both mean
  // the session itself). Only one that starts with @here goes to my agent here instead, for
  // a session of my own; a teammate's session has no agent here, so every word goes to it.
  function route(row, text) {
    const value = String(text ?? '').trimStart(), first = value.split(/\s+/)[0], rest = value.slice(first.length).trim();
    if (byTeammate(row)) return { to: 'there', text: callsIt(row, first) ? rest : value.trim() };
    if (first.toLowerCase() === HERE) return { to: 'here', text: rest };
    return { to: 'there', text: callsIt(row, first) || /^@model$/i.test(first) ? rest : value.trim() };
  }
  // The model of a session there: the one its computer says its next message goes to, else
  // (an older ELU there) the one its newest reply here names; null when neither is known.
  const modelOf = row => { const name = row.remote?.model ?? (row.remote?.entries ?? []).findLast(entry => entry.lead && !entry.bot && !entry.shell)?.role; return name ? remote(name, 40) || null : null; };
  // The message box, while a session on another computer is under the cursor: who the
  // message goes to and on which computer, the longest that fits in max. typed: what is in
  // the box, which may ask for my agent here by name.
  const label = (row, max = Infinity, typed = '') => {
    const forms = byTeammate(row) ? [` Message ${row.remote.title ? 'this session' : 'it'} on @${row.machine} `]
      : route(row, typed).to === 'here' ? [` Message your agent here · it helps the session on @${row.machine} `, ' Message your agent here ']
      : [` Message ${modelOf(row) ?? 'the session'} on @${row.machine} `, ` Message @${row.machine} `];
    return forms.find(form => columns(form) <= max) ?? forms.at(-1);
  };
  // A message of any length goes: one too long for one line on the link is sent in pieces
  // first, and the daemon is waited for a second longer for every 300 KB of it.
  const patience = (text, base = 10000) => ({ timeoutMs: base + Math.ceil(Buffer.byteLength(String(text ?? '')) / 300) });
  // Where a new session would run on that computer, and the folders the owner picks from
  // while its home folder is a project there and no team setting decides (lib/peer/remote.mjs):
  // { root, project, folders: [{ path, label, name, project }] }, else null. A build there from
  // before the choice, or a daemon here that cannot ask, says null: the session starts as before.
  async function folders(machine) {
    let where = null; try { where = await peerCommand({ type: 'remoteFolders', to: machine.key }); } catch { return null; }
    return where?.pick === true && Array.isArray(where.folders) && where.folders.length ? where : null;
  }
  // settings.folder: the folder picked there, from folders().
  async function start(machine, text, settings) {
    const result = await peerCommand({ type: 'remoteStart', to: machine.key, text, permissions: settings.permissions, place: settings.place, model: settings.model ?? null, bots: settings.bots ?? [], ...(settings.folder ? { folder: settings.folder } : {}) }, patience(text));
    // The list reads its rows again at once, so the new one is there for the cursor.
    read.at = 0;
    // That computer is offline: it is kept here, and goes as soon as it connects.
    if (result.unsent) return { id: result.id, key: `remote:${machine.key}\0remote\0${result.id}`, line: `@${machine.name} is offline. Your message goes as soon as it connects.` };
    return { id: result.id, key: `remote:${machine.key}\0remote\0${result.id}`, line: `Started on @${machine.name}${result.project ? ` in ${remote(result.project, 40)}` : ''}. It shows here as it works.` };
  }
  // A session not followed here yet is named by its computer and its place there: the daemon watches it first.
  const at = row => row.ref && !row.watched ? { to: row.remote.machine, ref: row.ref } : {};
  // A message that names files or folders on this computer offers to send them with it: one
  // line, y sends them, n sends the text alone (confirm answers it). Over a limit, the line says
  // so and y sends the text alone. sending(line): what the status line says while they go.
  // model: the text starts with a model's name (/model NAME message). It goes as typed: that
  // computer reads the name among its own models, runs the session on it from this message
  // on, and answers with the name it shows that model by, which the status line says.
  // typed: the owner typed it here himself, so it starts there whatever runs there (ownerTyped
  // in lib/workspace.mjs); what a session's tool sends there (send_to_session) says nothing.
  async function send(row, text, { confirm = null, sending = () => {}, model = false } = {}) {
    if (model) {
      const took = await peerCommand({ type: 'remoteSend', id: row.id, ...at(row), text, model: true, typed: true }), named = took?.model ?? 'that model';
      if (took?.sent) { written.add(row.id); read.at = 0; }
      return took?.sent ? `Sent to the session on @${row.machine}, now on ${named}.${sentWhile(row, took)}` : `The session on @${row.machine} uses ${named} from your next message.`;
    }
    const offer = confirm ? facade?.offerFiles?.(text) ?? null : null;
    if (offer?.refused) { if (!await confirm(`${offer.refused} Send the text only?`)) throw new Error('Nothing was sent. The message is still here.'); }
    else if (offer && await confirm(offer.line)) return sendFiles(row, offer, text, sending);
    const result = await peerCommand({ type: 'remoteSend', id: row.id, ...at(row), text, typed: true }, patience(text));
    // It stays listed under its computer, and the list reads its rows again at once.
    written.add(row.id); read.at = 0;
    // One that had not started went with its message: a run that waited there starts now, and
    // one not sent yet goes with it once that computer connects.
    if (result?.added) return result.unsent ? `Added to your message. It goes to @${row.machine} as soon as it connects.` : result.starts ? `Added to its message. It starts now on @${row.machine}.` : `Added to its message on @${row.machine}.`;
    return `Sent to ${modelOf(row) ?? 'the session'} on @${row.machine}.${sentWhile(row, result)}`;
  }
  // /send PATH...: the files alone, after the same line.
  async function sendPaths(row, paths, { confirm, sending = () => {} }) {
    const offer = facade?.offerPaths?.(paths);
    if (!offer) throw new Error('Files cannot be sent from this computer.');
    if (!await confirm(offer.line)) return 'Nothing was sent.';
    return sendFiles(row, offer, '', sending);
  }
  // The daemon waits for each piece to be taken there: a minute, and a second for every 300 KB.
  async function sendFiles(row, offer, text, sending) {
    const files = facade.stageFiles(offer);
    sending(`Sending ${fileCount(files.count)} to @${row.machine}…`);
    const result = await peerCommand({ type: 'remoteFiles', id: row.id, ...at(row), text, files, typed: true }, patience(text, 60000 + Math.ceil(files.bytes / 300)));
    written.add(row.id); read.at = 0;
    return `Sent ${fileCount(Number.isSafeInteger(result?.files) ? result.files : files.count)} to the session on @${row.machine}.`;
  }
  // y, n, s and c on a session on another computer. Whoever answers first, here or there, wins.
  // always: a, once the owner chose where (scope 'project' or 'all'). The rule is kept on the
  // computer the session runs on, since that is where its relay reads the rules.
  async function action(row, action, scope = null) {
    if (row.approval && action === 'always') {
      if (!row.approval.always) throw new Error('This one is asked each time. y allows it once, n denies it.');
      const { answered, kept } = await peerCommand({ type: 'remoteAnswer', id: row.id, ...at(row), approval: row.approval.id, decision: 'allow', always: scope === 'all' ? 'all' : 'project' });
      read.at = 0;
      if (!answered && !kept) return 'That approval was already answered.';
      return `${answered ? 'Allowed. ' : ''}From now on, without asking on @${row.machine}: ${kept ?? row.approval.always} (${scope === 'all' ? 'all your projects there' : 'this project'}).`;
    }
    if (row.approval && ['accept', 'decline'].includes(action)) {
      const { answered } = await peerCommand({ type: 'remoteAnswer', id: row.id, ...at(row), approval: row.approval.id, decision: action === 'accept' ? 'allow' : 'deny' });
      read.at = 0;
      return answered ? action === 'accept' ? 'Allowed.' : 'Denied.' : 'That approval was already answered.';
    }
    if (row.label === 'TASK' && ['accept', 'decline'].includes(action)) {
      const { answered } = await peerCommand({ type: 'remoteTask', id: row.id, ...at(row), decision: action === 'accept' ? 'approve' : 'reject' });
      return answered ? action === 'accept' ? `Task approved. It starts on @${row.machine}.` : 'Task rejected. Nothing was changed.' : 'That Task was already answered.';
    }
    if (action === 'stop') {
      const stopped = await peerCommand({ type: 'remoteStop', id: row.id, ...at(row) });
      // One not sent yet never goes; one that waited there to start never starts.
      if (stopped?.cancelled) { read.at = 0; return `Cancelled. Nothing was sent to @${row.machine}.`; }
      if (row.queued && row.remote?.state === 'starting') { read.at = 0; return `Cancelled on @${row.machine}. It will not start.`; }
      return `Stopping it on @${row.machine}. Changes and chat history are kept there.`;
    }
    // Sends what waits there now. A turn there that takes its messages takes them now and goes
    // on; any other stops as /stop stops it, and the waiting messages start the next one.
    if (action === 'sendNow') {
      const sent = await peerCommand({ type: 'remoteStop', id: row.id, ...at(row), now: true });
      return sent?.stopping === false ? `Sending now. The turn on @${row.machine} takes it and goes on.` : `Sending now. The turn on @${row.machine} stops and what waits there starts the next one.`;
    }
    if (action === 'close' && !row.listed) { await peerCommand({ type: 'remoteForget', id: row.id }); read.at = 0; return `Removed from this list. It stays on @${row.machine}.`; }
    return null;
  }
  // /rename, /archive, e, c and u over a session on a computer of mine: that computer renames,
  // archives or brings it back with its own code, and this list reads it again at once.
  // editLine(row, verb): the line for one whose computer listed itself on an ELU that cannot
  // (before 0.1.26), so nothing goes; null when it can or has not said.
  const editLine = (row, verb) => fresh(Date.now()).lists.get(row.remote?.machine)?.edit === false ? EDIT_UPDATE(`@${row.machine}`, verb) : null;
  const placeOf = row => ({ id: row.id, to: row.remote.machine, ...(row.ref ? { ref: row.ref } : {}) });
  // {title, titleBy, shown}: the name chosen there (null when none), who chose it, and what lists show.
  async function rename(row, title) {
    const result = await peerCommand({ type: 'remoteRename', ...placeOf(row), title }); read.at = 0;
    return result;
  }
  // archived: false brings it back. {archived, shown}.
  async function archive(row, archived = true) {
    const result = await peerCommand({ type: 'remoteArchive', ...placeOf(row), archived }); read.at = 0;
    return result;
  }
  // /mine: which of your teammates' machines are yours. Both machines mark each other, by
  // hand or, when both are signed in to the same GitHub account, by themselves.
  async function mine(args) {
    const all = machines(), marked = marks();
    if (!args.length) {
      const rows = [...marked.values()].filter(row => row.mine || row.theirs);
      // While pairing by GitHub cannot work here, how to pair is said once, at the end.
      let hint = null; try { hint = facade?.pairingHint?.() ?? null; } catch { hint = null; }
      if (!rows.length) return hint ? `No other computer is yours yet. ${hint}` : `No other computer is yours yet. Two computers on one team signed in to GitHub with gh as the same account pair by themselves; or run /mine @name here and on that computer.`;
      const said = rows.map(row => { const name = `@${all.get(row.key)?.name ?? row.key.slice(0, 8)}`; return row.mine && row.theirs ? `${name} is yours` : row.mine ? `${name}: waiting for it to mark this machine too` : `${name} marks this machine as its own; /mine ${name} agrees`; }).join(' · ');
      return hint ? `${said}. ${hint}` : said;
    }
    if (args[0] === 'auto') {
      if (args.length !== 2 || !['on', 'off'].includes(args[1])) throw new Error(`Use ${MINE_USAGE}.`);
      await peerCommand({ type: 'mineAuto', on: args[1] === 'on' });
      return args[1] === 'on' ? 'Computers signed in to the same GitHub account pair by themselves again.' : 'Computers no longer pair by GitHub account. The ones already yours stay yours; /mine remove @name ends one.';
    }
    const remove = args[0] === 'remove', word = remove ? args[1] : args[0];
    if (args.length !== (remove ? 2 : 1) || !word?.startsWith('@')) throw new Error(`Use ${MINE_USAGE}.`);
    const machine = find(word);
    if (!machine) throw new Error(`No computer on your team is called ${word}.`);
    if (remove) { await peerCommand({ type: 'unmine', key: machine.key }); marked.at = 0; return `@${machine.name} is no longer yours. Neither computer can start sessions on the other now, and it does not pair again by GitHub until you type /mine @${machine.name}.`; }
    const { both, older } = await peerCommand({ type: 'mine', key: machine.key }); marked.at = 0;
    return both ? `@${machine.name} is yours. Type @${machine.name} first in the new session box to start a session there.` : older ? `@${machine.name} needs to update ELU to run sessions from here.` : `Waiting for @${machine.name} to mark this machine too. On @${machine.name}, type /mine @${self()}.`;
  }
  // The line the app shows once when a computer of mine paired by GitHub, here or while the app
  // was closed in the last 10 minutes: the daemon notes pairedAt on its row (lib/peer/mine.mjs).
  const appStart = Date.now() - 600000, toldPairs = new Set();
  function paired() {
    const rows = list('mineRows').filter(row => row.auto === 'github' && row.mine && row.theirs && row.login && Date.parse(row.pairedAt ?? '') > appStart && !toldPairs.has(`${row.key}:${row.pairedAt}`));
    for (const row of rows) toldPairs.add(`${row.key}:${row.pairedAt}`);
    return rows.length ? rows.map(row => `@${nameOf(row.key)} is yours: both computers are signed in to GitHub as ${row.login}.`).join(' ') : null;
  }
  // The answer to "Is <name>'s computer yours too?" after joining with a code made for that: yes marks it here.
  async function agree(key, owner) {
    const { both } = await peerCommand({ type: 'mine', key }); marked.at = 0; const who = machines().get(key)?.name || plainName(owner) || key.slice(0, 8);
    return both ? `@${who} is yours. Type @${who} first in the new session box to start a session there.` : `Marked as yours. Type @${who} first in the new session box to start a session there.`;
  }
  // What my computers that are online now say their agents spent, for the Usage tab: one entry
  // each, { machine, top }, top null for one on a build that does not send it (or cannot list);
  // one that is offline is { machine, offline: true }, so the spend line says it is not counted.
  function agents(now = Date.now()) {
    const { lists } = fresh(now);
    return ours().map(machine => {
      if (!machine.online) return { machine, offline: true };
      const kept = lists.get(machine.key);
      return { machine, top: kept && !kept.older && kept.topAgents && typeof kept.topAgents === 'object' ? kept.topAgents : null, listed: Boolean(kept?.listedAt) || kept?.older === true };
    });
  }
  // Opens a session of a computer of mine in Sessions, by its project there: the key of its row.
  // One this machine follows is listed once, by the id it has here, so it is found by its place
  // there (ref) first, then by its listed id.
  function openSession(key, project, id, ref = null, root = null) {
    opened = { key, project };
    return (ref ? sessionKey(key, { ref }, root) : null) ?? `remote:${key}\0remote\0${id}`;
  }
  return { rows, sections, archivedCount, editLine, rename, archive, sessionKey, projects, openProject, openSession, agents, named, own, yours, words, view, parts, older, changes, label, route, folders, start, send, sendPaths, action, mine, agree, unmarked, self, paired };
}
